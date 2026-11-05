import fs from 'node:fs';
import path from 'node:path';
import { readCardJson } from './cards.mjs';
import { markTouched } from './touched.mjs';
import { httpError } from './util.mjs';

// Catalog of presets, lorebooks and cards from the community. The list lives
// in the project repository (catalog/catalog.json), so it grows without app
// updates. Installing = downloading the file into SillyTavern's folder; an
// existing file is never overwritten (a new name is picked instead).

export const CATALOG_URL = 'https://raw.githubusercontent.com/yogurt5633-hub/st-app/main/catalog/catalog.json';
const TYPES = new Set(['lorebook', 'preset', 'card']);
const MAX_BYTES = 20 * 1024 * 1024;
const CACHE_MS = 30 * 60 * 1000;
let cache = { at: 0, items: [], error: '', submit: '' };

/** An https link, or '' for anything else. */
export function cleanLink(value) {
    const text = String(value || '').trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text.slice(0, 300) : '';
}

/** After the author published a change: show it at once, without waiting for GitHub's cache. */
export function setCatalogCache(json) {
    cache = { at: Date.now(), items: cleanItems(json), error: '', submit: cleanLink(json?.submit) };
}

export function cleanItems(data) {
    const list = Array.isArray(data?.items) ? data.items : [];
    return list.filter(item => item && TYPES.has(item.type) && typeof item.id === 'string' && typeof item.name === 'string' && /^https:\/\//i.test(String(item.url || '')))
        .map(item => ({
            id: item.id.slice(0, 80),
            type: item.type,
            name: item.name.slice(0, 80),
            author: String(item.author || '').slice(0, 60),
            description: String(item.description || '').slice(0, 400),
            tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 8) : [],
            url: item.url,
            page: cleanLink(item.page),
            added: /^\d{4}-\d{2}-\d{2}$/.test(String(item.added || '')) ? item.added : '',
        }));
}

export async function loadCatalog({ force = false, fetchImpl = globalThis.fetch } = {}) {
    if (!force && Date.now() - cache.at < CACHE_MS) return cache;
    try {
        const res = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
        if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
        setCatalogCache(await res.json());
    } catch (error) {
        cache = { ...cache, at: Date.now() - CACHE_MS + 60000, error: `Каталог не загрузился: ${error.message}` };
    }
    return cache;
}

export function safeFileName(name) {
    const value = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
    return value || 'catalog';
}

async function freeName(dir, base, ext) {
    for (let i = 1; i < 100; i++) {
        const name = i === 1 ? base : `${base} (${i})`;
        try {
            await fs.promises.access(path.join(dir, name + ext));
        } catch {
            return name;
        }
    }
    throw httpError(409, 'Слишком много файлов с таким именем');
}

async function download(url, fetchImpl) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!res.ok) throw httpError(502, `Сайт с файлом ответил ${res.status}`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw httpError(413, 'Файл слишком большой');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) throw httpError(413, 'Файл слишком большой');
    return data;
}

/** Installs one catalog item. Returns where it went. */
export async function installItem(ctx, item, { fetchImpl = globalThis.fetch } = {}) {
    const data = await download(item.url, fetchImpl);
    const base = safeFileName(item.name);
    if (item.type === 'lorebook') {
        let json;
        try {
            json = JSON.parse(data.toString('utf8'));
        } catch {
            throw httpError(400, 'Файл лорбука не читается как JSON');
        }
        if (!json || typeof json.entries !== 'object') throw httpError(400, 'Это не лорбук SillyTavern: нет записей');
        const name = await freeName(ctx.dirs.worlds, base, '.json');
        await fs.promises.mkdir(ctx.dirs.worlds, { recursive: true });
        await fs.promises.writeFile(path.join(ctx.dirs.worlds, `${name}.json`), JSON.stringify(json, null, 4));
        markTouched(ctx.handle, 'world', name);
        return { type: 'lorebook', name, where: 'Лорбуки' };
    }
    if (item.type === 'preset') {
        let json;
        try {
            json = JSON.parse(data.toString('utf8'));
        } catch {
            throw httpError(400, 'Файл пресета не читается как JSON');
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw httpError(400, 'Это не пресет SillyTavern');
        const dir = ctx.dirs.openAI_Settings;
        const name = await freeName(dir, base, '.json');
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, `${name}.json`), JSON.stringify(json, null, 4));
        markTouched(ctx.handle, 'preset', name);
        return { type: 'preset', name, where: 'Пресеты Chat Completion' };
    }
    if (item.type === 'card') {
        let card = null;
        try {
            card = readCardJson(data);
        } catch {
            card = null;
        }
        if (!card) throw httpError(400, 'Это не карточка персонажа (нужен PNG с данными персонажа)');
        const name = await freeName(ctx.dirs.characters, base, '.png');
        await fs.promises.writeFile(path.join(ctx.dirs.characters, `${name}.png`), data);
        markTouched(ctx.handle, 'card', `${name}.png`);
        return { type: 'card', name, where: 'Персонажи' };
    }
    throw httpError(400, 'Неизвестный тип');
}
