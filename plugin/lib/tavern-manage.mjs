import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from './archive.mjs';
import { readCard, writeCard, readCardJson, writeCardJson, getCardField, setCardField, cardName, writePngChunks } from './cards.mjs';
import { cleanPreset, globalRegex, readRegexFile } from './catalog-publish.mjs';
import { installData } from './catalog.mjs';
import { extensionsDir, readExtensionPackage } from './extension-package.mjs';
import { readStSettings } from './st-settings.mjs';
import { markTouched } from './touched.mjs';
import { httpError, plainName, readJson, safeJoin, withLock, writeFileAtomic } from './util.mjs';
import { readWorld, writeWorld, listWorlds, entriesOf, freeUid, makeEntry, entryLabel } from './worlds.mjs';

async function editStSettings(ctx, mutator) {
    const file = path.join(ctx.dirs.root, 'settings.json');
    return withLock(`${ctx.dirs.root}:st-settings`, async () => {
        const data = await readJson(file, {});
        const result = await mutator(data);
        await writeFileAtomic(file, JSON.stringify(data, null, 4));
        markTouched(ctx.handle, 'settings', 'main');
        return result;
    });
}

async function backupBeforeDelete(korrektorDir, kind, name, fullPath, isDirectory = false) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(korrektorDir, 'backups', 'tavern', kind, stamp);
    await fs.promises.mkdir(dir, { recursive: true });
    if (isDirectory) {
        await fs.promises.cp(fullPath, path.join(dir, name), { recursive: true, dereference: false });
        await fs.promises.rm(fullPath, { recursive: true, force: true });
    } else {
        await fs.promises.copyFile(fullPath, path.join(dir, name));
        await fs.promises.rm(fullPath, { force: true });
    }
}

// ---------- 1. Presets ----------

export async function listTavernPresets(ctx) {
    const st = await readStSettings(ctx);
    const oai = st?.oai_settings || {};
    const active = String(st?.preset_settings_openai || oai.preset_settings_openai || '');
    const dir = ctx.dirs.openAI_Settings;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { entries = []; }
    const items = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
        const stat = await fs.promises.stat(path.join(dir, entry.name)).catch(() => null);
        if (!stat) continue;
        const name = entry.name.slice(0, -5);
        items.push({ file: entry.name, name, active: name === active || entry.name === active, size: stat.size, mtime: stat.mtimeMs });
    }
    items.sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime);
    return {
        active,
        params: {
            maxContext: Number(oai.openai_max_context) || 4096,
            maxTokens: Number(oai.openai_max_tokens) || 300,
            temp: Number(oai.temp_openai ?? 1),
            stream: Boolean(oai.stream_openai ?? true),
        },
        items,
    };
}

export async function activateTavernPreset(ctx, nameOrFile) {
    const base = String(nameOrFile || '').replace(/\.json$/i, '');
    const file = safeJoin(ctx.dirs.openAI_Settings, `${plainName(base)}.json`);
    const preset = await readJson(file, null);
    if (!preset || typeof preset !== 'object') throw httpError(404, 'Пресет не найден');
    await editStSettings(ctx, (st) => {
        st.preset_settings_openai = base;
        st.oai_settings = st.oai_settings || {};
        st.oai_settings.preset_settings_openai = base;
        for (const key of ['temp_openai', 'top_p_openai', 'top_k_openai', 'freq_pen_openai', 'pres_pen_openai', 'openai_max_context', 'openai_max_tokens', 'stream_openai', 'prompts', 'prompt_order']) {
            if (key in preset) st.oai_settings[key] = preset[key];
        }
    });
    markTouched(ctx.handle, 'preset', base);
    return { active: base };
}

export async function saveTavernPresetParams(ctx, body = {}) {
    return editStSettings(ctx, async (st) => {
        st.oai_settings = st.oai_settings || {};
        if (body.maxContext !== undefined) st.oai_settings.openai_max_context = Math.max(512, Math.min(2000000, Math.round(Number(body.maxContext) || 4096)));
        if (body.maxTokens !== undefined) st.oai_settings.openai_max_tokens = Math.max(16, Math.min(100000, Math.round(Number(body.maxTokens) || 300)));
        if (body.temp !== undefined) st.oai_settings.temp_openai = Math.max(0, Math.min(3, Number(body.temp) || 0));
        if (body.stream !== undefined) st.oai_settings.stream_openai = Boolean(body.stream);
        const active = String(st.preset_settings_openai || st.oai_settings.preset_settings_openai || '').replace(/\.json$/i, '');
        if (active) {
            const file = safeJoin(ctx.dirs.openAI_Settings, `${plainName(active)}.json`);
            const preset = await readJson(file, null);
            if (preset && typeof preset === 'object') {
                preset.openai_max_context = st.oai_settings.openai_max_context;
                preset.openai_max_tokens = st.oai_settings.openai_max_tokens;
                preset.temp_openai = st.oai_settings.temp_openai;
                preset.stream_openai = st.oai_settings.stream_openai;
                await writeFileAtomic(file, JSON.stringify(preset, null, 4));
            }
        }
        return {
            maxContext: st.oai_settings.openai_max_context,
            maxTokens: st.oai_settings.openai_max_tokens,
            temp: st.oai_settings.temp_openai,
            stream: st.oai_settings.stream_openai,
        };
    });
}

export async function readTavernPresetDetail(ctx, nameOrFile) {
    const base = String(nameOrFile || '').replace(/\.json$/i, '');
    const file = safeJoin(ctx.dirs.openAI_Settings, `${plainName(base)}.json`);
    const preset = await readJson(file, null);
    if (!preset || typeof preset !== 'object') throw httpError(404, 'Пресет не найден');
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const orderGroup = Array.isArray(preset.prompt_order)
        ? (preset.prompt_order.find(g => Number(g?.character_id) === 100001) || preset.prompt_order[0])
        : null;
    const orderMap = new Map();
    if (Array.isArray(orderGroup?.order)) {
        orderGroup.order.forEach((item, idx) => {
            if (item?.identifier) orderMap.set(item.identifier, { enabled: Boolean(item.enabled), index: idx });
        });
    }
    const items = prompts.filter(p => p && typeof p === 'object' && p.identifier).map((p, idx) => {
        const state = orderMap.get(p.identifier);
        return {
            identifier: p.identifier,
            name: String(p.name || p.identifier),
            role: String(p.role || 'system'),
            content: String(p.content || ''),
            enabled: state ? state.enabled : Boolean(p.enabled ?? true),
            order: state ? state.index : idx + 1000,
        };
    }).sort((a, b) => a.order - b.order);
    return { name: base, file: `${base}.json`, prompts: items };
}

export async function updateTavernPresetPrompt(ctx, nameOrFile, { identifier, enabled, content, name } = {}) {
    const base = String(nameOrFile || '').replace(/\.json$/i, '');
    const file = safeJoin(ctx.dirs.openAI_Settings, `${plainName(base)}.json`);
    const preset = await readJson(file, null);
    if (!preset || typeof preset !== 'object') throw httpError(404, 'Пресет не найден');
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const target = prompts.find(p => p && p.identifier === identifier);
    if (!target) throw httpError(404, 'Промпт в пресете не найден');
    if (content !== undefined) target.content = String(content);
    if (name !== undefined && String(name).trim()) target.name = String(name).trim();
    if (enabled !== undefined) {
        target.enabled = Boolean(enabled);
        if (Array.isArray(preset.prompt_order)) {
            for (const group of preset.prompt_order) {
                const entry = Array.isArray(group?.order) ? group.order.find(o => o?.identifier === identifier) : null;
                if (entry) entry.enabled = Boolean(enabled);
            }
        }
    }
    await writeFileAtomic(file, JSON.stringify(preset, null, 4));
    await editStSettings(ctx, (st) => {
        const active = String(st.preset_settings_openai || st.oai_settings?.preset_settings_openai || '').replace(/\.json$/i, '');
        if (active === base && st.oai_settings) {
            st.oai_settings.prompts = preset.prompts;
            st.oai_settings.prompt_order = preset.prompt_order;
        }
    });
    markTouched(ctx.handle, 'preset', base);
    return readTavernPresetDetail(ctx, base);
}

export async function deleteTavernPreset(ctx, korrektorDir, nameOrFile) {
    const base = String(nameOrFile || '').replace(/\.json$/i, '');
    const file = safeJoin(ctx.dirs.openAI_Settings, `${plainName(base)}.json`);
    if (!fs.existsSync(file)) throw httpError(404, 'Пресет не найден');
    await backupBeforeDelete(korrektorDir, 'presets', `${base}.json`, file);
    markTouched(ctx.handle, 'preset', base);
    return { deleted: base };
}

// ---------- 2. Lorebooks ----------

export async function listTavernLorebooks(ctx) {
    const st = await readStSettings(ctx);
    const active = new Set(Array.isArray(st?.world_info_settings?.world_info?.globalSelect) ? st.world_info_settings.world_info.globalSelect : []);
    const names = await listWorlds(ctx);
    const items = [];
    for (const name of names) {
        try {
            const world = await readWorld(ctx, name);
            const list = entriesOf(world);
            items.push({ name, file: `${name}.json`, active: active.has(name), entries: list.length, enabledEntries: list.filter(e => !e.disable).length });
        } catch {
            items.push({ name, file: `${name}.json`, active: active.has(name), entries: 0, enabledEntries: 0 });
        }
    }
    items.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'ru'));
    return { items };
}

export async function toggleTavernLorebook(ctx, name, active) {
    const clean = plainName(String(name || '').replace(/\.json$/i, ''));
    return editStSettings(ctx, (st) => {
        st.world_info_settings = st.world_info_settings || {};
        st.world_info_settings.world_info = st.world_info_settings.world_info || {};
        const current = Array.isArray(st.world_info_settings.world_info.globalSelect)
            ? st.world_info_settings.world_info.globalSelect.filter(x => typeof x === 'string')
            : [];
        const set = new Set(current);
        if (active) set.add(clean);
        else set.delete(clean);
        st.world_info_settings.world_info.globalSelect = [...set];
        markTouched(ctx.handle, 'world', clean);
        return { name: clean, active: set.has(clean), globalSelect: [...set] };
    });
}
export async function readTavernLorebookDetail(ctx, name) {
    const clean = plainName(String(name || '').replace(/\.json$/i, ''));
    const world = await readWorld(ctx, clean);
    const items = entriesOf(world).map(e => ({
        uid: e.uid,
        comment: String(e.comment || ''),
        label: entryLabel(e),
        key: Array.isArray(e.key) ? e.key : [],
        content: String(e.content || ''),
        constant: Boolean(e.constant),
        disable: Boolean(e.disable),
    }));
    return { name: clean, entries: items };
}

export async function saveTavernLorebookEntry(ctx, name, body = {}) {
    const clean = plainName(String(name || '').replace(/\.json$/i, ''));
    const world = await readWorld(ctx, clean);
    const keys = Array.isArray(body.key)
        ? body.key.map(k => String(k).trim()).filter(Boolean)
        : String(body.key || '').split(',').map(k => k.trim()).filter(Boolean);
    if (body.uid === undefined || body.uid === null || body.uid === '') {
        const uid = freeUid(world);
        world.data.entries[uid] = makeEntry(uid, {
            comment: String(body.comment || '').trim(),
            key: keys,
            content: String(body.content || ''),
            constant: Boolean(body.constant),
            disable: Boolean(body.disable),
        });
    } else {
        const entry = world.data.entries[body.uid];
        if (!entry) throw httpError(404, 'Запись в лорбуке не найдена');
        if (body.comment !== undefined) entry.comment = String(body.comment);
        if (body.key !== undefined) entry.key = keys;
        if (body.content !== undefined) entry.content = String(body.content);
        if (body.constant !== undefined) entry.constant = Boolean(body.constant);
        if (body.disable !== undefined) entry.disable = Boolean(body.disable);
    }
    await writeWorld(world);
    markTouched(ctx.handle, 'world', clean);
    return readTavernLorebookDetail(ctx, clean);
}

export async function deleteTavernLorebookEntry(ctx, name, uid) {
    const clean = plainName(String(name || '').replace(/\.json$/i, ''));
    const world = await readWorld(ctx, clean);
    if (!world.data.entries || !(uid in world.data.entries)) throw httpError(404, 'Запись не найдена');
    delete world.data.entries[uid];
    await writeWorld(world);
    markTouched(ctx.handle, 'world', clean);
    return readTavernLorebookDetail(ctx, clean);
}

export async function deleteTavernLorebook(ctx, korrektorDir, name) {
    const clean = plainName(String(name || '').replace(/\.json$/i, ''));
    const world = await readWorld(ctx, clean);
    await backupBeforeDelete(korrektorDir, 'worlds', `${clean}.json`, world.path);
    await toggleTavernLorebook(ctx, clean, false).catch(() => {});
    markTouched(ctx.handle, 'world', clean);
    return { deleted: clean };
}

// ---------- 3. Character cards ----------

export async function readTavernCardDetail(ctx, avatar) {
    const entry = await readCard(ctx, avatar);
    const c = entry.card;
    return {
        avatar: entry.avatar,
        name: cardName(c, entry.avatar.replace(/\.png$/i, '')),
        description: getCardField(c, 'description'),
        personality: getCardField(c, 'personality'),
        scenario: getCardField(c, 'scenario'),
        first_mes: getCardField(c, 'first_mes'),
        mes_example: getCardField(c, 'mes_example'),
        system_prompt: getCardField(c, 'system_prompt'),
        depth_prompt: getCardField(c, 'depth_prompt'),
        creator_notes: getCardField(c, 'creator_notes'),
        world: String(c?.data?.extensions?.world || ''),
        hasEmbeddedLorebook: Boolean(c?.data?.character_book?.entries && Object.keys(c.data.character_book.entries).length),
    };
}

export async function saveTavernCardDetail(ctx, avatar, body = {}) {
    const entry = await readCard(ctx, avatar);
    const c = entry.card;
    c.data = c.data || {};
    if (body.name !== undefined && String(body.name).trim()) {
        c.name = String(body.name).trim();
        c.data.name = String(body.name).trim();
    }
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'depth_prompt', 'creator_notes']) {
        if (body[field] !== undefined) setCardField(c, field, String(body[field]));
    }
    if (body.world !== undefined) {
        c.data.extensions = c.data.extensions || {};
        const w = String(body.world || '').trim();
        if (w) c.data.extensions.world = w;
        else delete c.data.extensions.world;
    }
    await writeCard(entry);
    markTouched(ctx.handle, 'card', entry.avatar);
    return readTavernCardDetail(ctx, entry.avatar);
}

export async function deleteTavernCard(ctx, korrektorDir, avatar) {
    const entry = await readCard(ctx, avatar);
    await backupBeforeDelete(korrektorDir, 'cards', entry.avatar, entry.path);
    markTouched(ctx.handle, 'card', entry.avatar);
    return { deleted: entry.avatar };
}
// ---------- 4. Extensions ----------

async function scanExtensionsIn(dir, scope, disabledSet) {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const items = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const folder = path.join(dir, entry.name);
        const manifest = await readJson(path.join(folder, 'manifest.json'), null);
        if (!manifest || typeof manifest !== 'object') continue;
        const id = scope === 'global' ? `third-party/${entry.name}` : entry.name;
        const disabled = disabledSet.has(entry.name) || disabledSet.has(id) || disabledSet.has(`third-party/${entry.name}`);
        items.push({
            id: entry.name,
            scope,
            name: String(manifest.display_name || entry.name),
            version: String(manifest.version || ''),
            author: String(manifest.author || ''),
            enabled: !disabled,
            builtinCompanion: entry.name === 'korrektor-sync',
        });
    }
    return items;
}

export async function listTavernExtensions(ctx) {
    const st = await readStSettings(ctx);
    const disabledList = Array.isArray(st?.extension_settings?.disabledExtensions) ? st.extension_settings.disabledExtensions : [];
    const disabledSet = new Set(disabledList.map(String));
    const userDir = extensionsDir(ctx);
    const thirdPartyDir = path.join(ctx.dirs.root, 'extensions', 'third-party');
    const seen = new Set();
    const items = [];
    for (const item of [
        ...(await scanExtensionsIn(userDir, 'user', disabledSet)),
        ...(userDir !== thirdPartyDir ? await scanExtensionsIn(thirdPartyDir, 'global', disabledSet) : []),
    ]) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
    }
    items.sort((a, b) => Number(a.builtinCompanion) - Number(b.builtinCompanion) || a.name.localeCompare(b.name, 'ru'));
    return { items };
}

export async function toggleTavernExtension(ctx, id, enabled) {
    const clean = plainName(String(id || ''));
    return editStSettings(ctx, (st) => {
        st.extension_settings = st.extension_settings || {};
        const list = Array.isArray(st.extension_settings.disabledExtensions)
            ? st.extension_settings.disabledExtensions.map(String)
            : [];
        const next = list.filter(x => x !== clean && x !== `third-party/${clean}`);
        if (!enabled) next.push(clean, `third-party/${clean}`);
        st.extension_settings.disabledExtensions = [...new Set(next)];
        return { id: clean, enabled: Boolean(enabled) };
    });
}

export async function deleteTavernExtension(ctx, korrektorDir, id) {
    const clean = plainName(String(id || ''));
    if (clean === 'korrektor-sync') throw httpError(400, 'Расширение синхронизации Тавернки удалять не нужно');
    const full = safeJoin(extensionsDir(ctx), clean);
    const stat = await fs.promises.lstat(full).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw httpError(404, 'Расширение не найдено');
    await backupBeforeDelete(korrektorDir, 'extensions', clean, full, true);
    markTouched(ctx.handle, 'settings', 'main');
    return { deleted: clean };
}

// ---------- 5. Regexes ----------

export async function listTavernRegexes(ctx) {
    const st = await readStSettings(ctx);
    const list = globalRegex(st);
    return {
        items: list.map((s, idx) => ({
            id: String(s.id || idx),
            index: idx,
            scriptName: String(s.scriptName || `Регекс #${idx + 1}`),
            findRegex: String(s.findRegex || ''),
            replaceString: String(s.replaceString || ''),
            disabled: Boolean(s.disabled),
            markdownOnly: Boolean(s.markdownOnly),
            promptOnly: Boolean(s.promptOnly),
        })),
    };
}

export async function saveTavernRegex(ctx, body = {}) {
    return editStSettings(ctx, (st) => {
        st.extension_settings = st.extension_settings || {};
        if (!Array.isArray(st.extension_settings.regex)) st.extension_settings.regex = [];
        const list = st.extension_settings.regex;
        const idx = body.index !== undefined && Number.isInteger(Number(body.index))
            ? Number(body.index)
            : list.findIndex(r => r && String(r.id) === String(body.id));
        if (idx >= 0 && list[idx]) {
            const cur = list[idx];
            if (body.scriptName !== undefined) cur.scriptName = String(body.scriptName).trim() || 'Регекс';
            if (body.findRegex !== undefined) cur.findRegex = String(body.findRegex);
            if (body.replaceString !== undefined) cur.replaceString = String(body.replaceString);
            if (body.disabled !== undefined) cur.disabled = Boolean(body.disabled);
            if (body.markdownOnly !== undefined) cur.markdownOnly = Boolean(body.markdownOnly);
            if (body.promptOnly !== undefined) cur.promptOnly = Boolean(body.promptOnly);
        } else {
            if (!String(body.findRegex || '').trim()) throw httpError(400, 'Укажите регулярное выражение (findRegex)');
            list.push({
                id: crypto.randomUUID(),
                scriptName: String(body.scriptName || 'Новый регекс').trim(),
                findRegex: String(body.findRegex),
                replaceString: String(body.replaceString || ''),
                trimStrings: [],
                placement: [1, 2],
                disabled: Boolean(body.disabled),
                markdownOnly: Boolean(body.markdownOnly),
                promptOnly: Boolean(body.promptOnly),
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
        }
        return { count: list.length };
    });
}
export async function deleteTavernRegex(ctx, idOrIndex) {
    return editStSettings(ctx, (st) => {
        const list = st?.extension_settings?.regex;
        if (!Array.isArray(list)) throw httpError(404, 'Регекс не найден');
        const idx = Number.isInteger(Number(idOrIndex)) && Number(idOrIndex) >= 0 && Number(idOrIndex) < list.length
            ? Number(idOrIndex)
            : list.findIndex(r => r && String(r.id) === String(idOrIndex));
        if (idx < 0) throw httpError(404, 'Регекс не найден');
        list.splice(idx, 1);
        return { count: list.length };
    });
}

export async function importTavernRegexFile(ctx, buffer) {
    const scripts = readRegexFile(buffer);
    return editStSettings(ctx, (st) => {
        st.extension_settings = st.extension_settings || {};
        if (!Array.isArray(st.extension_settings.regex)) st.extension_settings.regex = [];
        const existing = st.extension_settings.regex;
        const seen = new Set(existing.map(s => `${s?.scriptName}\u0000${s?.findRegex}`));
        let added = 0;
        for (const s of scripts) {
            const key = `${s.scriptName}\u0000${s.findRegex}`;
            if (seen.has(key)) continue;
            seen.add(key);
            existing.push({ ...s, id: typeof s.id === 'string' && s.id ? s.id : crypto.randomUUID() });
            added++;
        }
        return { added, names: scripts.map(s => String(s.scriptName || 'Регекс')) };
    });
}

// ---------- 6. Conversion & packaging for SillyTavern ----------

export function makeBlankCardPng() {
    const width = 160;
    const height = 220;
    const rowSize = 1 + width * 4;
    const raw = Buffer.alloc(rowSize * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * rowSize;
        raw[rowStart] = 0;
        for (let x = 0; x < width; x++) {
            const p = rowStart + 1 + x * 4;
            raw[p] = 0x2a;
            raw[p + 1] = 0x23;
            raw[p + 2] = 0x1e;
            raw[p + 3] = 0xff;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const idat = zlib.deflateSync(raw);
    return writePngChunks([
        { type: 'IHDR', data: ihdr },
        { type: 'IDAT', data: idat },
        { type: 'IEND', data: Buffer.alloc(0) },
    ]);
}

function normalizeCardObject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const name = String(d.name || raw.name || raw.char_name || '').trim();
    const description = String(d.description ?? raw.description ?? raw.char_persona ?? '');
    const firstMes = String(d.first_mes ?? raw.first_mes ?? raw.char_greeting ?? '');
    if (!name && !description && !firstMes) return null;
    const personality = String(d.personality ?? raw.personality ?? '');
    const scenario = String(d.scenario ?? raw.scenario ?? raw.world_scenario ?? '');
    const mesExample = String(d.mes_example ?? raw.mes_example ?? raw.example_dialogue ?? '');
    const card = {
        name: name || 'Персонаж',
        description,
        personality,
        scenario,
        first_mes: firstMes,
        mes_example: mesExample,
        creatorcomment: String(d.creator_notes ?? raw.creatorcomment ?? ''),
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: name || 'Персонаж',
            description,
            personality,
            scenario,
            first_mes: firstMes,
            mes_example: mesExample,
            creator_notes: String(d.creator_notes ?? raw.creatorcomment ?? ''),
            system_prompt: String(d.system_prompt ?? ''),
            post_history_instructions: String(d.post_history_instructions ?? ''),
            tags: Array.isArray(d.tags) ? d.tags : [],
            alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
            extensions: d.extensions && typeof d.extensions === 'object' ? d.extensions : {},
        },
    };
    if (d.character_book && typeof d.character_book === 'object') card.data.character_book = d.character_book;
    return card;
}

function normalizeLorebookObject(raw, fallbackName = 'Лорбук') {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw.character_book && typeof raw.character_book === 'object'
        ? raw.character_book
        : raw.data?.character_book && typeof raw.data.character_book === 'object'
            ? raw.data.character_book
            : raw;
    const rawEntries = Array.isArray(source) ? source : source.entries;
    if (!rawEntries || typeof rawEntries !== 'object') return null;
    const list = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries);
    const entries = {};
    list.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const keys = Array.isArray(item.keys) ? item.keys : Array.isArray(item.key) ? item.key : typeof item.key === 'string' ? item.key.split(',').map(s => s.trim()).filter(Boolean) : [];
        const secondary = Array.isArray(item.secondary_keys) ? item.secondary_keys : Array.isArray(item.keysecondary) ? item.keysecondary : [];
        const uid = Number.isInteger(Number(item.uid)) ? Number(item.uid) : idx;
        entries[uid] = makeEntry(uid, {
            key: keys,
            keysecondary: secondary,
            comment: String(item.comment || item.name || ''),
            content: String(item.content || item.entry || ''),
            constant: Boolean(item.constant),
            disable: Boolean(item.disable ?? (item.enabled === false)),
            order: Number(item.insertion_order ?? item.order ?? 100) || 100,
            position: Number(item.position ?? 0) || 0,
        });
    });
    return { name: String(source.name || raw.name || fallbackName), entries };
}

export function buildZipBuffer(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const item of entries) {
        const nameBuf = Buffer.from(item.name.replace(/\\/g, '/'), 'utf8');
        const raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
        const compressed = zlib.deflateRawSync(raw);
        const sum = crc32(raw);
        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(sum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        nameBuf.copy(local, 30);
        locals.push(local, compressed);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(sum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);
        centrals.push(central);
        offset += local.length + compressed.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

export async function packInstalledExtensionZip(ctx, id) {
    const clean = plainName(String(id || ''));
    const root = safeJoin(extensionsDir(ctx), clean);
    const stat = await fs.promises.lstat(root).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw httpError(404, 'Расширение не найдено');
    const files = [];
    async function walk(dir, prefix) {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of list) {
            if (entry.name === '.git' || entry.isSymbolicLink()) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full, rel);
            else if (entry.isFile()) files.push({ name: `${clean}/${rel}`, data: await fs.promises.readFile(full) });
        }
    }
    await walk(root, '');
    if (!files.length) throw httpError(400, 'Папка расширения пуста');
    return { fileName: `${clean}.zip`, data: buildZipBuffer(files) };
}

export async function convertForSillyTavern(ctx, { name = 'file', data, action = 'inspect', targetFormat = '' } = {}) {
    if (!Buffer.isBuffer(data) || !data.length) throw httpError(400, 'Файл пустой');
    const baseName = path.basename(String(name || 'file')).replace(/\.[^.]+$/, '') || 'item';

    if (data[0] === 0x89 && data[1] === 0x50) {
        const card = readCardJson(data);
        const normalized = normalizeCardObject(card) || card;
        const title = cardName(normalized, baseName);
        const hasLore = Boolean(normalized?.data?.character_book?.entries && Object.keys(normalized.data.character_book.entries).length);
        if (action === 'install') {
            const png = writeCardJson(data, normalized);
            const installed = await installData(ctx, 'card', png, title);
            let loreInstalled = null;
            if (targetFormat === 'with-lorebook' && hasLore) {
                const lore = normalizeLorebookObject(normalized, `${title} — лорбук`);
                loreInstalled = await installData(ctx, 'lorebook', Buffer.from(JSON.stringify(lore, null, 4)), `${title} — лорбук`);
            }
            return { installed, loreInstalled };
        }
        if (action === 'download') {
            if (targetFormat === 'json') return { fileName: `${title}.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(normalized, null, 4)) };
            if (targetFormat === 'lorebook' && hasLore) {
                const lore = normalizeLorebookObject(normalized, `${title} — лорбук`);
                return { fileName: `${title}-lorebook.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(lore, null, 4)) };
            }
            return { fileName: `${title}.png`, mime: 'image/png', data: writeCardJson(data, normalized) };
        }
        return {
            detected: 'card-png',
            title,
            summary: `PNG-карточка персонажа «${title}»${hasLore ? ' (внутри также вшит лорбук)' : ''}`,
            formats: [
                { id: 'png', label: 'PNG-карточка SillyTavern (V2 + V3)' },
                { id: 'json', label: 'JSON данных персонажа (V3)' },
                ...(hasLore ? [{ id: 'lorebook', label: 'Извлечь вшитый лорбук (.json)' }] : []),
            ],
            canInstall: true,
            canInstallLorebook: hasLore,
        };
    }

    if (data[0] === 0x50 && data[1] === 0x4b) {
        const pkg = readExtensionPackage(data);
        const cleanZip = buildZipBuffer(pkg.entries);
        if (action === 'install') return { installed: await installData(ctx, 'extension', cleanZip, pkg.title) };
        if (action === 'download') return { fileName: `${pkg.title || baseName}.zip`, mime: 'application/zip', data: cleanZip };
        return {
            detected: 'extension-zip',
            title: pkg.title,
            summary: `ZIP-расширение «${pkg.title}» (${pkg.entries.length} файлов, manifest.json проверен)`,
            formats: [{ id: 'zip', label: 'Готовый ZIP расширения для SillyTavern' }],
            canInstall: true,
        };
    }

    let json;
    try { json = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw httpError(400, 'Формат не распознан: выберите PNG, JSON или ZIP'); }

    const regexList = (Array.isArray(json) ? json : [json]).filter(s => s && typeof s === 'object' && typeof s.findRegex === 'string');
    if (regexList.length) {
        const title = regexList.length === 1 ? String(regexList[0].scriptName || baseName) : `Регексы (${regexList.length})`;
        if (action === 'install') {
            const r = await importTavernRegexFile(ctx, Buffer.from(JSON.stringify(regexList)));
            return { installed: { where: 'Регексы SillyTavern', name: `${r.added} добавлено` } };
        }
        if (action === 'download') return { fileName: `${baseName}-regex.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(regexList, null, 4)) };
        return {
            detected: 'regex',
            title,
            summary: `Правила Regex для SillyTavern: ${regexList.map(r => r.scriptName || 'без названия').join(', ')}`,
            formats: [{ id: 'json', label: 'JSON регексов SillyTavern' }],
            canInstall: true,
        };
    }

    if (json && typeof json === 'object' && !Array.isArray(json) && (Array.isArray(json.prompts) || 'temp_openai' in json || 'openai_max_context' in json)) {
        const { json: cleaned, removed } = cleanPreset(json);
        const embeddedRegex = Array.isArray(cleaned?.extensions?.regex_scripts) ? cleaned.extensions.regex_scripts : [];
        if (action === 'install') return { installed: await installData(ctx, 'preset', Buffer.from(JSON.stringify(cleaned, null, 4)), baseName) };
        if (action === 'download') {
            if (targetFormat === 'regex' && embeddedRegex.length) {
                return { fileName: `${baseName}-regex.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(embeddedRegex, null, 4)) };
            }
            return { fileName: `${baseName}.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(cleaned, null, 4)) };
        }
        return {
            detected: 'preset',
            title: baseName,
            summary: `Пресет Chat Completion${removed.length ? ` (очищено секретов/прокси: ${removed.length})` : ''}${embeddedRegex.length ? ` · вшито регексов: ${embeddedRegex.length}` : ''}`,
            formats: [
                { id: 'json', label: 'Очищенный пресет SillyTavern (.json)' },
                ...(embeddedRegex.length ? [{ id: 'regex', label: 'Извлечь вшитые регексы (.json)' }] : []),
            ],
            canInstall: true,
        };
    }

    const asCard = normalizeCardObject(json);
    if (asCard && !('entries' in json && !('first_mes' in json) && !('data' in json))) {
        const title = asCard.name || baseName;
        const hasLore = Boolean(asCard.data?.character_book?.entries);
        const pngData = writeCardJson(makeBlankCardPng(), asCard);
        if (action === 'install') return { installed: await installData(ctx, 'card', pngData, title) };
        if (action === 'download') {
            if (targetFormat === 'json') return { fileName: `${title}.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(asCard, null, 4)) };
            if (targetFormat === 'lorebook' && hasLore) {
                const lore = normalizeLorebookObject(asCard, `${title} — лорбук`);
                return { fileName: `${title}-lorebook.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(lore, null, 4)) };
            }
            return { fileName: `${title}.png`, mime: 'image/png', data: pngData };
        }
        return {
            detected: 'card-json',
            title,
            summary: `JSON-карточка персонажа «${title}» — сконвертирована в формат SillyTavern PNG (V2 + V3)`,
            formats: [
                { id: 'png', label: 'Готовая PNG-карточка SillyTavern' },
                { id: 'json', label: 'JSON карточки (V3)' },
                ...(hasLore ? [{ id: 'lorebook', label: 'Извлечь вшитый лорбук (.json)' }] : []),
            ],
            canInstall: true,
        };
    }

    const asLore = normalizeLorebookObject(json, baseName);
    if (asLore) {
        const count = Object.keys(asLore.entries).length;
        const buf = Buffer.from(JSON.stringify({ entries: asLore.entries }, null, 4));
        if (action === 'install') return { installed: await installData(ctx, 'lorebook', buf, asLore.name || baseName) };
        if (action === 'download') return { fileName: `${asLore.name || baseName}.json`, mime: 'application/json', data: buf };
        return {
            detected: 'lorebook',
            title: asLore.name || baseName,
            summary: `Лорбук «${asLore.name || baseName}» (${count} записей) в формате World Info SillyTavern`,
            formats: [{ id: 'json', label: 'Лорбук SillyTavern (.json)' }],
            canInstall: true,
        };
    }

    throw httpError(400, 'Не удалось определить тип JSON: не похоже на карточку, лорбук, пресет или регекс');
}




