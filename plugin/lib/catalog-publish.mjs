// Catalog for its author: files from this SillyTavern for sending or publishing,
// and publishing to the catalog on GitHub (catalog/catalog.json + catalog/files/).
//
// The GitHub token is kept in korrektor/catalog-admin.json of this SillyTavern user.
// It is never sent back to the page, never synced and never packed into backups.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readCardJson } from './cards.mjs';
import { httpError, isInside, readJson, writeJson } from './util.mjs';
import { cleanItems, cleanLink, setCatalogCache } from './catalog.mjs';

export const CATALOG_REPO = 'yogurt5633-hub/st-app';
export const CATALOG_BRANCH = 'main';
const CATALOG_PATH = 'catalog/catalog.json';
const MAX_BYTES = 20 * 1024 * 1024;

export const ADMIN_FILE = 'catalog-admin.json';
export const UPLOAD_DIR = 'catalog-uploads';

// ---------- files of this SillyTavern ----------

const KINDS = {
    preset: { dir: (ctx) => ctx.dirs.openAI_Settings, ext: '.json', label: 'пресет' },
    lorebook: { dir: (ctx) => ctx.dirs.worlds, ext: '.json', label: 'лорбук' },
    card: { dir: (ctx) => ctx.dirs.characters, ext: '.png', label: 'карточку' },
};

function kind(type) {
    const k = KINDS[type];
    if (!k) throw httpError(400, 'Тип: пресет, лорбук или карточка');
    return k;
}

/** Presets, lorebooks or cards of this SillyTavern, newest first. */
export async function listLocal(ctx, type) {
    const k = kind(type);
    let entries = [];
    try {
        entries = await fs.promises.readdir(k.dir(ctx), { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(k.ext)) continue;
        const stat = await fs.promises.stat(path.join(k.dir(ctx), entry.name)).catch(() => null);
        if (!stat) continue;
        out.push({ file: entry.name, name: entry.name.slice(0, -k.ext.length), size: stat.size, mtime: stat.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 2000);
}

// Fields of a Chat Completion preset that can hold a password, a private address or headers with a key.
const PRIVATE_PRESET_FIELDS = ['proxy_password', 'reverse_proxy', 'custom_url', 'custom_include_headers', 'custom_include_body', 'custom_exclude_body'];

/** A preset without passwords, private addresses and anything that looks like a key. */
export function cleanPreset(json) {
    const out = { ...json };
    const removed = [];
    for (const key of Object.keys(out)) {
        // Not «max_tokens»: only names that mean a key, a password or a secret.
        if (PRIVATE_PRESET_FIELDS.includes(key) || /^(token|key)$|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|passwd|secret/i.test(key)) {
            if (out[key] !== '' && out[key] !== null && out[key] !== undefined) removed.push(key);
            delete out[key];
        }
    }
    return { json: out, removed };
}

/**
 * Checks that bytes really are a preset, a lorebook or a card, and cleans a preset.
 * Returns { data, ext, title, removed }.
 */
export function checkFile(type, data, fallbackTitle = '') {
    if (!data?.length) throw httpError(400, 'Файл пустой');
    if (data.length > MAX_BYTES) throw httpError(413, 'Файл больше 20 МБ');
    if (type === 'card') {
        let card = null;
        try {
            card = readCardJson(data);
        } catch {
            card = null;
        }
        if (!card) throw httpError(400, 'Это не карточка персонажа: нужен PNG с данными персонажа');
        const title = String(card.data?.name || card.name || fallbackTitle || 'Персонаж');
        return { data, ext: '.png', title, removed: [] };
    }
    let json;
    try {
        json = JSON.parse(data.toString('utf8').replace(/^﻿/, ''));
    } catch {
        throw httpError(400, 'Файл не читается как JSON');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw httpError(400, 'Это не файл SillyTavern');
    if (type === 'lorebook') {
        if (typeof json.entries !== 'object' || json.entries === null) throw httpError(400, 'Это не лорбук SillyTavern: нет записей');
        return { data: Buffer.from(JSON.stringify(json, null, 4)), ext: '.json', title: String(json.name || fallbackTitle || 'Лорбук'), removed: [] };
    }
    if (type === 'preset') {
        if ('entries' in json && !('prompts' in json)) throw httpError(400, 'Похоже на лорбук, а не на пресет');
        const { json: clean, removed } = cleanPreset(json);
        return { data: Buffer.from(JSON.stringify(clean, null, 4)), ext: '.json', title: fallbackTitle || 'Пресет', removed };
    }
    throw httpError(400, 'Тип: пресет, лорбук или карточка');
}

/** One file of this SillyTavern, checked and cleaned, for saving or publishing. */
export async function readLocal(ctx, type, file) {
    const k = kind(type);
    const name = path.basename(String(file || ''));
    if (!name || name !== String(file) || !name.toLowerCase().endsWith(k.ext)) throw httpError(400, 'Нет такого файла');
    const full = path.join(k.dir(ctx), name);
    if (!isInside(k.dir(ctx), full)) throw httpError(400, 'Нет такого файла');
    let data;
    try {
        data = await fs.promises.readFile(full);
    } catch {
        throw httpError(404, 'Файл не найден');
    }
    return { ...checkFile(type, data, name.slice(0, -k.ext.length)), fileName: name };
}

// ---------- uploads from the phone (kept until published) ----------

export async function saveCatalogUpload(korrektorDir, type, data, fileName) {
    const k = kind(type);
    const checked = checkFile(type, data, path.basename(String(fileName || '')).replace(/\.[^.]+$/, ''));
    const id = `u${Date.now()}`;
    const dir = path.join(korrektorDir, UPLOAD_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    // Old unpublished uploads are not kept for long.
    for (const old of await fs.promises.readdir(dir).catch(() => [])) {
        const stat = await fs.promises.stat(path.join(dir, old)).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 24 * 3600 * 1000) await fs.promises.rm(path.join(dir, old), { force: true });
    }
    await fs.promises.writeFile(path.join(dir, `${id}${k.ext}`), checked.data);
    return { upload: id, title: checked.title, removed: checked.removed, size: checked.data.length };
}

async function readUpload(korrektorDir, type, id) {
    const k = kind(type);
    if (!/^u\d+$/.test(String(id || ''))) throw httpError(400, 'Нет такой загрузки');
    const file = path.join(korrektorDir, UPLOAD_DIR, `${id}${k.ext}`);
    try {
        return { data: await fs.promises.readFile(file), ext: k.ext, file };
    } catch {
        throw httpError(404, 'Загруженный файл не найден: выберите его ещё раз');
    }
}

// ---------- token ----------

export async function readAdmin(korrektorDir) {
    const cfg = await readJson(path.join(korrektorDir, ADMIN_FILE), {});
    return { token: typeof cfg.token === 'string' ? cfg.token : '', login: String(cfg.login || '') };
}

export async function saveAdmin(korrektorDir, value) {
    const file = path.join(korrektorDir, ADMIN_FILE);
    if (!value) {
        await fs.promises.rm(file, { force: true });
        return;
    }
    await writeJson(file, value);
    await fs.promises.chmod(file, 0o600).catch(() => { });
}

// ---------- GitHub ----------

async function gh(token, method, url, body, fetchImpl = globalThis.fetch) {
    let res;
    try {
        res = await fetchImpl(`https://api.github.com${url}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Korrektor',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60000),
        });
    } catch (error) {
        throw httpError(502, `GitHub не отвечает: ${error.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const err = httpError(res.status === 404 ? 404 : res.status === 409 || res.status === 422 ? 409 : 502,
        res.status === 401 ? 'GitHub не принял токен: он неверный или истёк'
            : res.status === 403 ? 'У токена нет права менять файлы этого репозитория (нужно Contents: Read and write)'
                : res.status === 404 ? 'Репозиторий или файл не найден: проверьте, что токен выдан для этого репозитория'
                    : `GitHub ответил ${res.status}: ${data.message || ''}`);
    err.github = res.status;
    throw err;
}

const contentsUrl = (p) => `/repos/${CATALOG_REPO}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
export const rawUrl = (p) => `https://raw.githubusercontent.com/${CATALOG_REPO}/${CATALOG_BRANCH}/${p.split('/').map(encodeURIComponent).join('/')}`;

/** Checks a token: the repository is reachable with it. Returns the GitHub login. */
export async function checkToken(token, { fetchImpl } = {}) {
    if (!/^[A-Za-z0-9_]{20,255}$/.test(String(token || ''))) throw httpError(400, 'Это не похоже на токен GitHub');
    const user = await gh(token, 'GET', '/user', null, fetchImpl).catch(() => ({}));
    const repo = await gh(token, 'GET', `/repos/${CATALOG_REPO}`, null, fetchImpl);
    if (repo.permissions && repo.permissions.push === false) throw httpError(403, 'Этим аккаунтом нельзя менять репозиторий каталога');
    return { login: String(user.login || '') };
}

async function readCatalogFile(token, fetchImpl) {
    try {
        const file = await gh(token, 'GET', `${contentsUrl(CATALOG_PATH)}?ref=${CATALOG_BRANCH}`, null, fetchImpl);
        const json = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8'));
        return { json: json && typeof json === 'object' ? json : { items: [] }, sha: file.sha };
    } catch (error) {
        if (error.github === 404) return { json: { items: [] }, sha: undefined };
        throw error;
    }
}

/** The catalog as it is on GitHub right now (GitHub's file cache can lag a few minutes). */
export async function readCatalogFresh(token, { fetchImpl } = {}) {
    const { json } = await readCatalogFile(token, fetchImpl);
    setCatalogCache(json);
    return json;
}

/**
 * Changes catalog.json with `change(json)`; on a conflict (someone changed it meanwhile)
 * reads it again and retries. `first` is a copy read just before, to save a request.
 */
async function updateCatalog(token, message, change, fetchImpl, first = null) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const { json, sha } = attempt === 0 && first ? first : await readCatalogFile(token, fetchImpl);
        if (!Array.isArray(json.items)) json.items = [];
        const result = change(json);
        // Lets the app tell a fresh copy from an older one still in GitHub's cache.
        json.updated = new Date().toISOString();
        try {
            await gh(token, 'PUT', contentsUrl(CATALOG_PATH), {
                message,
                content: Buffer.from(`${JSON.stringify(json, null, 4)}\n`).toString('base64'),
                branch: CATALOG_BRANCH,
                ...(sha ? { sha } : {}),
            }, fetchImpl);
            setCatalogCache(json);
            return result;
        } catch (error) {
            if (error.github !== 409 && error.github !== 422) throw error;
        }
    }
    throw httpError(409, 'Каталог одновременно меняли в другом месте: попробуйте ещё раз');
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

export function slug(text) {
    const latin = String(text || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('');
    return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'item';
}

function cleanMeta(meta, fallbackTitle) {
    const name = String(meta?.name || fallbackTitle || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'Нужно название');
    const author = String(meta?.author || '').trim().slice(0, 60);
    if (!author) throw httpError(400, 'Нужен автор: в каталоге он указывается всегда');
    if (!meta?.allowed) throw httpError(400, 'Публиковать можно только с разрешения автора');
    const tags = (Array.isArray(meta.tags) ? meta.tags : String(meta.tags || '').split(','))
        .map(t => String(t).trim()).filter(Boolean).slice(0, 8).map(t => t.slice(0, 30));
    return {
        name,
        author,
        description: String(meta.description || '').trim().slice(0, 400),
        tags,
        page: cleanLink(meta.page),
    };
}

/**
 * Publishes a file to the catalog: puts it into catalog/files/<type>s/ and adds a record
 * at the top of catalog.json. `source` is { file } (this SillyTavern) or { upload } (from the phone).
 */
export async function publishItem({ ctx, korrektorDir, token, type, source, meta, fetchImpl }) {
    let file;
    let uploadFile = null;
    if (source?.upload) {
        const up = await readUpload(korrektorDir, type, source.upload);
        file = { ...checkFile(type, up.data, meta?.name) };
        uploadFile = up.file;
    } else {
        file = await readLocal(ctx, type, source?.file);
    }
    const info = cleanMeta(meta, file.title);
    const date = new Date().toISOString().slice(0, 10);

    // A free id: the file name in the repository is the id, so it must not clash.
    const first = await readCatalogFile(token, fetchImpl);
    const current = first.json;
    const taken = new Set((current.items || []).map(i => i.id));
    const base = `${type}-${slug(info.name)}`;
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    const repoPath = `catalog/files/${type}s/${id}${file.ext}`;

    await gh(token, 'PUT', contentsUrl(repoPath), {
        message: `Каталог: файл «${info.name}»`,
        content: file.data.toString('base64'),
        branch: CATALOG_BRANCH,
    }, fetchImpl);

    // The fingerprint lets every tavern see whether it already has this file.
    const hash = crypto.createHash('sha256').update(file.data).digest('hex');
    const item = { id, type, ...info, url: rawUrl(repoPath), added: date, hash, size: file.data.length };
    if (!item.page) delete item.page;
    await updateCatalog(token, `Каталог: добавлен «${info.name}» (${info.author})`, (json) => {
        json.items = [item, ...json.items.filter(i => i?.id !== id)];
    }, fetchImpl, first);
    if (uploadFile) await fs.promises.rm(uploadFile, { force: true });
    return { item: cleanItems({ items: [item] })[0], removed: file.removed, localFile: uploadFile ? null : file.fileName };
}

/** Removes a record; its file goes too when it lives in this repository's catalog/files/. */
export async function removeItem({ token, id, fetchImpl }) {
    let removed = null;
    await updateCatalog(token, `Каталог: убрана запись ${id}`, (json) => {
        removed = json.items.find(i => i?.id === id) || null;
        json.items = json.items.filter(i => i?.id !== id);
    }, fetchImpl);
    if (!removed) throw httpError(404, 'Такой записи в каталоге нет');
    const prefix = `https://raw.githubusercontent.com/${CATALOG_REPO}/${CATALOG_BRANCH}/`;
    if (String(removed.url || '').startsWith(`${prefix}catalog/files/`)) {
        const repoPath = decodeURIComponent(removed.url.slice(prefix.length));
        try {
            const meta = await gh(token, 'GET', `${contentsUrl(repoPath)}?ref=${CATALOG_BRANCH}`, null, fetchImpl);
            await gh(token, 'DELETE', contentsUrl(repoPath), { message: `Каталог: удалён файл ${repoPath}`, sha: meta.sha, branch: CATALOG_BRANCH }, fetchImpl);
        } catch {
            // the record is gone; a file left behind harms nothing
        }
    }
    return { removed: removed.name };
}

/** Where people send their presets and lorebooks (a Telegram link): kept in catalog.json. */
/** A Telegram address written any usual way: @nick, nick, t.me/nick, t.me/channel?direct, a full link. */
export function submitLink(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) text = `https://t.me/${text.replace(/^@/, '')}`;
    else if (/^(t\.me|telegram\.me|www\.)/i.test(text)) text = `https://${text}`;
    else if (/^http:\/\//i.test(text)) text = text.replace(/^http:/i, 'https:');
    return cleanLink(text);
}

export async function setSubmitLink({ token, link, fetchImpl }) {
    const clean = submitLink(link);
    if (link && !clean) throw httpError(400, 'Не похоже на ссылку: впишите t.me/ник, @ник или полную ссылку');
    await updateCatalog(token, 'Каталог: куда присылать предложения', (json) => {
        if (clean) json.submit = clean;
        else delete json.submit;
    }, fetchImpl);
    return { submit: clean };
}
