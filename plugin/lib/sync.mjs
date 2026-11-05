import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpError, isInside, readJson, writeFileAtomic, writeJson } from './util.mjs';

// Two-way sync of two SillyTavern installs (phone and PC) through their Korrektor plugins.
// What is synced: chats, group chats, characters, lorebooks, presets, backgrounds,
// persona pictures and character galleries. Not synced: settings.json (each device has
// its own connection and look), secrets.json (keys never leave their device).
//
// Rules:
//  - a file changed on one side only goes to the other side;
//  - a file changed on both sides: the newer one wins; for a chat the other version is kept
//    as a separate chat ("…копия с ПК"), for anything else it goes to korrektor/backups;
//  - nothing is ever deleted by sync; every overwritten file is backed up first.

export const SYNC_DIRS = ['chats', 'group chats', 'groups', 'characters', 'worlds', 'OpenAI Settings', 'backgrounds', 'User Avatars', 'user/images'];
const MAX_FILE = 64 * 1024 * 1024;

/** "телефон" in Termux, "ПК" elsewhere: names the copies made on a conflict. */
export function deviceName() {
    if (String(process.env.PREFIX || '').includes('com.termux') || fs.existsSync('/data/data/com.termux')) return 'телефон';
    return 'ПК';
}

const GENITIVE = { 'телефон': 'телефона', 'ПК': 'ПК' };

/** A relative name allowed for sync, or null. */
export function cleanName(name) {
    const value = String(name || '').replace(/\\/g, '/');
    if (!value || value.startsWith('/') || value.split('/').some(p => p === '..' || p === '' || p === '.')) return null;
    if (!SYNC_DIRS.some(dir => value.startsWith(`${dir}/`))) return null;
    if (/(^|\/)\.[^/]*$/.test(value)) return null; // hidden and temp files
    return value;
}

export function fullPath(root, name) {
    const clean = cleanName(name);
    if (!clean) throw httpError(400, 'Недопустимое имя файла');
    const file = path.join(root, ...clean.split('/'));
    if (!isInside(root, file)) throw httpError(400, 'Недопустимое имя файла');
    return file;
}

/** { name: { size, mtime } } for every synced file. mtime in whole seconds. */
export async function localManifest(root) {
    const files = {};
    async function walk(dir, prefix) {
        let entries = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
            const rel = `${prefix}/${entry.name}`;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full, rel);
            else if (entry.isFile()) {
                const stat = await fs.promises.stat(full);
                if (stat.size <= MAX_FILE) files[rel] = { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
            }
        }
    }
    for (const dir of SYNC_DIRS) await walk(path.join(root, ...dir.split('/')), dir);
    return files;
}

function same(a, b) {
    return Boolean(a && b && a.size === b.size && Math.abs(a.mtime - b.mtime) <= 2);
}

/**
 * What to do with each file. state: what each side had after the last sync,
 * { name: { l: {size, mtime}, r: {size, mtime} } }.
 * Returns [{ name, action: 'upload' | 'download' | 'conflict' }].
 */
export function planSync(local, remote, state = {}) {
    const plan = [];
    for (const name of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const l = local[name];
        const r = remote[name];
        const s = state[name];
        if (l && r && same(l, r)) continue;
        if (l && !r) {
            plan.push({ name, action: 'upload' });
            continue;
        }
        if (r && !l) {
            plan.push({ name, action: 'download' });
            continue;
        }
        const localChanged = !same(l, s?.l);
        const remoteChanged = !same(r, s?.r);
        if (localChanged && !remoteChanged) plan.push({ name, action: 'upload' });
        else if (remoteChanged && !localChanged) plan.push({ name, action: 'download' });
        else plan.push({ name, action: 'conflict', newer: l.mtime >= r.mtime ? 'local' : 'remote' });
    }
    return plan.sort((a, b) => a.name.localeCompare(b.name));
}

/** Name for the losing copy of a chat: a separate chat next to it. */
export function conflictName(name, device, now = new Date()) {
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const who = (GENITIVE[device] || String(device || 'другого устройства')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    return `${base} - копия с ${who} ${stamp}${ext}`;
}

/** Writes a synced file: the old content goes to backups first; mtime is copied from the source. */
export async function writeSynced(root, backupsDir, name, data, mtime, stamp) {
    const file = fullPath(root, name);
    try {
        const old = await fs.promises.readFile(file);
        const backup = path.join(backupsDir, `sync-${stamp}`, ...name.split('/'));
        await fs.promises.mkdir(path.dirname(backup), { recursive: true });
        await fs.promises.writeFile(backup, old);
    } catch {
        // a new file: nothing to back up
    }
    await writeFileAtomic(file, data);
    if (Number.isFinite(mtime) && mtime > 0) await fs.promises.utimes(file, mtime, mtime);
}

/**
 * Runs one sync. peer: { manifest(), get(name), put(name, data, mtime), device }.
 * Returns what happened, with the chats that changed (for the open tabs to reload).
 */
export async function runSync({ root, backupsDir, statePath, peer, peerKey, log = () => { }, now = new Date() }) {
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const all = await readJson(statePath, { peers: {} });
    all.peers = all.peers || {};
    const state = all.peers[peerKey]?.files || {};
    log('Сравниваю файлы');
    const local = await localManifest(root);
    const remoteInfo = await peer.manifest();
    const remote = remoteInfo.files || {};
    const device = remoteInfo.device || peer.device || 'другого устройства';
    const plan = planSync(local, remote, state);
    const result = { device, uploaded: [], downloaded: [], conflicts: [], errors: [], at: now.toISOString() };
    const nextState = { ...state };
    const both = (meta) => ({ l: meta, r: meta });

    for (const step of plan) {
        const { name } = step;
        try {
            if (step.action === 'upload') {
                log(`→ ${name}`);
                const data = await fs.promises.readFile(fullPath(root, name));
                await peer.put(name, data, local[name].mtime);
                result.uploaded.push(name);
                nextState[name] = both(local[name]);
            } else if (step.action === 'download') {
                log(`← ${name}`);
                const data = await peer.get(name);
                await writeSynced(root, backupsDir, name, data, remote[name].mtime, stamp);
                result.downloaded.push(name);
                nextState[name] = both(remote[name]);
            } else {
                // Both sides changed. The newer one becomes the file on both devices.
                const isChat = /\.jsonl$/i.test(name);
                const localData = await fs.promises.readFile(fullPath(root, name));
                const remoteData = await peer.get(name);
                // The same content with other dates (for example SillyTavern's own default files): nothing to do.
                if (localData.equals(remoteData)) {
                    nextState[name] = { l: local[name], r: remote[name] };
                    continue;
                }
                if (step.newer === 'local') {
                    if (isChat) {
                        const copy = conflictName(name, device, now);
                        await peer.put(copy, remoteData, remote[name].mtime);
                        await writeSynced(root, backupsDir, copy, remoteData, remote[name].mtime, stamp);
                        nextState[copy] = both({ size: remoteData.length, mtime: remote[name].mtime });
                        result.conflicts.push({ name, kept: 'это устройство', copy });
                    } else {
                        result.conflicts.push({ name, kept: 'это устройство', copy: null });
                    }
                    await peer.put(name, localData, local[name].mtime);
                    nextState[name] = both(local[name]);
                } else {
                    if (isChat) {
                        const copy = conflictName(name, deviceName(), now);
                        await writeSynced(root, backupsDir, copy, localData, local[name].mtime, stamp);
                        await peer.put(copy, localData, local[name].mtime);
                        nextState[copy] = both({ size: localData.length, mtime: local[name].mtime });
                        result.conflicts.push({ name, kept: device, copy });
                    } else {
                        result.conflicts.push({ name, kept: device, copy: null });
                    }
                    await writeSynced(root, backupsDir, name, remoteData, remote[name].mtime, stamp);
                    nextState[name] = both(remote[name]);
                }
            }
        } catch (error) {
            result.errors.push(`${name}: ${error.message}`);
        }
    }
    // Files both sides already had the same way are in sync too.
    for (const name of Object.keys(local)) if (remote[name] && same(local[name], remote[name])) nextState[name] = both(local[name]);
    all.peers[peerKey] = { files: nextState, last: { ...result, uploaded: result.uploaded.length, downloaded: result.downloaded.length } };
    await writeJson(statePath, all);
    return result;
}

// ---------- the other device over HTTP ----------

function cookiesFrom(res, jar) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/);
    for (const raw of list) {
        const pair = String(raw).split(';')[0].trim();
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
}

/**
 * Talks to the Korrektor plugin of the other SillyTavern, as a logged-in user of it:
 * CSRF token and session cookie like a browser; basicAuth or account login if set.
 */
export class PeerClient {
    constructor({ url, login = '', password = '', fetchImpl = globalThis.fetch }) {
        this.base = String(url || '').replace(/\/+$/, '');
        if (!/^https?:\/\/[^/]+/i.test(this.base)) throw httpError(400, 'Адрес другой таверны должен выглядеть так: http://192.168.1.10:8000');
        this.login = login;
        this.password = password;
        this.fetch = fetchImpl;
        this.jar = new Map();
        this.csrf = '';
    }

    headers(extra = {}) {
        const h = { ...extra };
        if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
        if (this.csrf) h['X-CSRF-Token'] = this.csrf;
        if (this.login && this.password) h.Authorization = `Basic ${Buffer.from(`${this.login}:${this.password}`).toString('base64')}`;
        return h;
    }

    async request(method, pathname, { body, raw, timeout = 60000, retry = true } = {}) {
        if (!this.csrf) await this.connect();
        let res;
        try {
            res = await this.fetch(this.base + pathname, {
                method,
                headers: this.headers(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
                signal: AbortSignal.timeout(timeout),
            });
        } catch (error) {
            throw httpError(502, `Другая таверна не отвечает (${this.base}): ${error.message}`);
        }
        cookiesFrom(res, this.jar);
        if ((res.status === 401 || res.status === 403) && retry) {
            this.csrf = '';
            await this.connect(true);
            return this.request(method, pathname, { body, raw, timeout, retry: false });
        }
        if (res.status === 404 && pathname.startsWith('/api/plugins/korrektor')) {
            throw httpError(502, 'На другой таверне нет Корректора нужной версии: установите или обновите его там');
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw httpError(502, `Другая таверна ответила ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
        }
        return res;
    }

    async connect(withLogin = false) {
        let res;
        try {
            res = await this.fetch(`${this.base}/csrf-token`, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
        } catch (error) {
            throw httpError(502, `Не удалось достучаться до ${this.base}: ${error.message}. Проверьте адрес, что таверна там запущена и открыта для сети (listen: true)`);
        }
        if (res.status === 401) throw httpError(401, 'Другая таверна просит логин и пароль (basicAuth): впишите их');
        if (res.status === 403) throw httpError(403, 'Другая таверна не пускает это устройство: добавьте его адрес в whitelist в её config.yaml или выключите whitelistMode и включите basicAuth');
        if (!res.ok) throw httpError(502, `Другая таверна ответила ${res.status}`);
        cookiesFrom(res, this.jar);
        this.csrf = (await res.json()).token || '';
        // With user accounts on, sign in as that user.
        if (withLogin && this.login) {
            const login = await this.fetch(`${this.base}/api/users/login`, {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ handle: this.login, password: this.password }),
                signal: AbortSignal.timeout(15000),
            });
            cookiesFrom(login, this.jar);
        }
    }

    async manifest() {
        const res = await this.request('GET', '/api/plugins/korrektor/sync/manifest', { timeout: 120000 });
        return res.json();
    }

    async get(name) {
        const res = await this.request('GET', `/api/plugins/korrektor/sync/file?name=${encodeURIComponent(name)}`, { timeout: 300000 });
        return Buffer.from(await res.arrayBuffer());
    }

    async put(name, data, mtime) {
        await this.request('POST', `/api/plugins/korrektor/sync/file?name=${encodeURIComponent(name)}&mtime=${encodeURIComponent(mtime)}`, { raw: data, timeout: 300000 });
    }
}

/** Reads a raw request body into a buffer (the size is capped). */
export async function readBody(req, limit = MAX_FILE) {
    if (Buffer.isBuffer(req.body)) return req.body;
    return new Promise((resolve, reject) => {
        const parts = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
                req.destroy();
                reject(httpError(413, 'Файл слишком большой'));
                return;
            }
            parts.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(parts)));
        req.on('error', reject);
    });
}
