import fs from 'node:fs';
import path from 'node:path';
import { httpError, plainName, safeJoin, sha256, writeFileAtomic } from './util.mjs';

// Lorebooks (World Info) live in data/<user>/worlds/<name>.json as { entries: { [uid]: entry } }.

// Same defaults as SillyTavern's newWorldInfoEntryTemplate.
export const ENTRY_TEMPLATE = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
});

export function worldPath(ctx, name) {
    return safeJoin(ctx.dirs.worlds, `${plainName(name)}.json`);
}

export async function readWorld(ctx, name, { allowMissing = false } = {}) {
    const file = worldPath(ctx, name);
    let raw;
    try {
        raw = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (allowMissing) return { name, path: file, data: { entries: {} }, hash: null, missing: true };
            throw httpError(404, `Лорбук «${name}» не найден`);
        }
        throw error;
    }
    const data = JSON.parse(raw.replace(/^﻿/, ''));
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};
    return { name, path: file, data, hash: sha256(raw), missing: false };
}

export async function writeWorld(world) {
    const raw = JSON.stringify(world.data, null, 4);
    await writeFileAtomic(world.path, raw);
    world.missing = false;
    return sha256(raw);
}

export async function listWorlds(ctx) {
    let entries = [];
    try {
        entries = await fs.promises.readdir(ctx.dirs.worlds, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json'))
        .map(e => path.parse(e.name).name)
        .sort((a, b) => a.localeCompare(b));
}

export function entriesOf(world) {
    return Object.values(world.data.entries || {}).filter(e => e && typeof e === 'object');
}

export function freeUid(world) {
    const used = new Set(Object.keys(world.data.entries || {}).map(Number));
    let uid = 0;
    while (used.has(uid)) uid++;
    return uid;
}

export function makeEntry(uid, fields) {
    return { uid, ...structuredClone(ENTRY_TEMPLATE), ...fields };
}

export function entryLabel(entry) {
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    return entry.comment || keys.slice(0, 3).join(', ') || `#${entry.uid}`;
}
