// Which catalog items are already in this SillyTavern, and removing them again.
//
// An item counts as installed when it was installed (or published) from here and the
// file is still there, or when a file of the same kind has exactly the same content.
// Content is compared in the same normalised form the catalog uses (JSON re-written,
// presets without private fields), so formatting differences do not matter.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkFile } from './catalog-publish.mjs';
import { markTouched } from './touched.mjs';
import { httpError, readJson, writeJson } from './util.mjs';

const KINDS = {
    preset: { dir: (ctx) => ctx.dirs.openAI_Settings, ext: '.json', where: 'Пресеты Chat Completion' },
    lorebook: { dir: (ctx) => ctx.dirs.worlds, ext: '.json', where: 'Лорбуки' },
    card: { dir: (ctx) => ctx.dirs.characters, ext: '.png', where: 'Персонажи' },
};
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const FINGERPRINTS = 'catalog-fingerprints.json';

export function fingerprint(type, data) {
    const clean = checkFile(type, data).data;
    return { hash: crypto.createHash('sha256').update(clean).digest('hex'), size: clean.length };
}

// ---------- this tavern's files ----------

const localCache = new Map(); // full path → { key, hash }

async function localHashes(ctx, type, cardSizes) {
    const k = KINDS[type];
    const dir = k.dir(ctx);
    const out = new Map();
    let entries = [];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(k.ext)) continue;
        const full = path.join(dir, entry.name);
        const stat = await fs.promises.stat(full).catch(() => null);
        if (!stat) continue;
        // Cards are big and many: only those of exactly the right size are read.
        if (type === 'card' && !cardSizes.has(stat.size)) continue;
        const key = `${stat.mtimeMs}:${stat.size}`;
        let hit = localCache.get(full);
        if (!hit || hit.key !== key) {
            try {
                hit = { key, hash: fingerprint(type, await fs.promises.readFile(full)).hash };
            } catch {
                hit = { key, hash: '' };
            }
            localCache.set(full, hit);
        }
        if (hit.hash && !out.has(hit.hash)) out.set(hit.hash, entry.name);
    }
    return out;
}

// ---------- catalog files ----------

/** The fingerprint of a catalog item: from the record, or downloaded once and remembered. */
async function itemFingerprint(item, korrektorDir, fetchImpl, memo) {
    if (/^[0-9a-f]{64}$/.test(String(item.hash || '')) && Number(item.size) > 0) return { hash: item.hash, size: Number(item.size) };
    if (memo[item.url]) return memo[item.url];
    const res = await fetchImpl(item.url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_DOWNLOAD) throw new Error('too big');
    memo[item.url] = fingerprint(item.type, data);
    memo.changed = true;
    return memo[item.url];
}

/**
 * { [id]: { file, where } } for the items that are in this SillyTavern.
 * `tracked` is { [id]: { type, file } } of installs and publishes made from here.
 */
export async function catalogStatus({ ctx, korrektorDir, items, tracked = {}, fetchImpl = globalThis.fetch }) {
    const out = {};
    for (const item of items) {
        const t = tracked[item.id];
        const k = KINDS[item.type];
        if (t && k && fs.existsSync(path.join(k.dir(ctx), t.file))) out[item.id] = { file: t.file, where: k.where };
    }
    const memoFile = path.join(korrektorDir, FINGERPRINTS);
    const memo = await readJson(memoFile, {});
    for (const type of Object.keys(KINDS)) {
        const pending = items.filter(i => i.type === type && !out[i.id]);
        if (!pending.length) continue;
        const prints = [];
        for (const item of pending.slice(0, 60)) {
            try {
                prints.push([item, await itemFingerprint(item, korrektorDir, fetchImpl, memo)]);
            } catch {
                // the file did not download: the item just shows «Установить»
            }
        }
        if (!prints.length) continue;
        const local = await localHashes(ctx, type, new Set(prints.map(([, p]) => p.size)));
        for (const [item, print] of prints) {
            const file = local.get(print.hash);
            if (file) out[item.id] = { file, where: KINDS[type].where };
        }
    }
    if (memo.changed) {
        delete memo.changed;
        await writeJson(memoFile, memo).catch(() => { });
    }
    return out;
}

/**
 * Removes an installed catalog item from SillyTavern. The file first goes to
 * korrektor/backups/catalog/, so it can be put back by hand.
 */
export async function uninstallItem({ ctx, korrektorDir, item, file }) {
    const k = KINDS[item.type];
    if (!k) throw httpError(400, 'Неизвестный тип');
    const name = path.basename(String(file || ''));
    const full = path.join(k.dir(ctx), name);
    if (!name || !fs.existsSync(full)) throw httpError(404, 'Этого файла в таверне уже нет');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(korrektorDir, 'backups', 'catalog', stamp);
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.copyFile(full, path.join(backupDir, name));
    await fs.promises.rm(full);
    localCache.delete(full);
    const base = name.slice(0, -k.ext.length);
    markTouched(ctx.handle, item.type === 'lorebook' ? 'world' : item.type, item.type === 'card' ? name : base);
    return { name: base, where: k.where, backup: path.join('korrektor', 'backups', 'catalog', stamp, name) };
}
