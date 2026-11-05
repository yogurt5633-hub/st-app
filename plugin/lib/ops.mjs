import fs from 'node:fs';
import path from 'node:path';
import { readChat, writeChat, messageText, setMessageText } from './chats.mjs';
import { readWorld, writeWorld, freeUid, makeEntry, entryLabel } from './worlds.mjs';
import { readCard, writeCard, getCardField, setCardField, cardName } from './cards.mjs';
import { httpError, isInside, newId, nowIso, sha256, withLock, writeJson, readJson } from './util.mjs';
import { markTouched } from './touched.mjs';

/*
 Change operations. Every op carries the value it expects to find ("before")
 and the value it writes ("after"). Apply refuses to touch a file whose
 current content no longer matches "before", so an analysis made on an older
 version of a chat can never overwrite newer text.

   chat.setMessage  { chatId, index, before, after }          message text (and active swipe)
   chat.setHidden   { chatId, indices, before:[bool], after:[bool] }  hide from prompt (is_system)
   chat.setMeta     { chatId, key, before, after }            chat_metadata[key], e.g. note_prompt
   chat.setMemory   { chatId, index, before, after }          messages[index].extra.memory (Summarize)
   world.addEntry   { world, entry, create? }                 new lorebook entry
   world.updateEntry{ world, uid, before:{...}, after:{...} } changed entry fields
   world.deleteEntry{ world, uid, before:entry }              removed entry
   card.setField    { avatar, field, before, after }          character card field
*/

const MAX_BACKUPS = 100;

function targetKey(op) {
    if (op.op.startsWith('chat.')) return `chat:${op.chatId}`;
    if (op.op.startsWith('world.')) return `world:${op.world}`;
    if (op.op.startsWith('card.')) return `card:${op.avatar}`;
    throw httpError(400, `Неизвестная операция ${op.op}`);
}

function same(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** If messages were added or removed before the target, find the message by its text nearby. */
function locateMessage(chat, index, expected) {
    const messages = chat.messages;
    if (messages[index] && messageText(messages[index]) === expected) return index;
    for (let delta = 1; delta <= 50; delta++) {
        for (const i of [index - delta, index + delta]) {
            if (i >= 0 && i < messages.length && messageText(messages[i]) === expected) return i;
        }
    }
    return -1;
}

async function loadTarget(ctx, key, ops) {
    const [type, ...rest] = key.split(':');
    const ref = rest.join(':');
    if (type === 'chat') {
        const chat = await readChat(ctx, ref);
        return { type, ref, value: chat, path: chat.path, original: chat.raw, hash: chat.hash };
    }
    if (type === 'world') {
        const allowMissing = ops.some(op => op.op === 'world.addEntry' && op.create);
        const world = await readWorld(ctx, ref, { allowMissing });
        const original = world.missing ? null : await fs.promises.readFile(world.path, 'utf8');
        return { type, ref, value: world, path: world.path, original, hash: world.hash };
    }
    const card = await readCard(ctx, ref);
    return { type, ref, value: card, path: card.path, original: card.buffer, hash: card.hash };
}

function checkAndApply(target, op, problems) {
    const fail = (text) => problems.push({ op: op.op, text });
    const applied = { ...op };

    switch (op.op) {
        case 'chat.setMessage': {
            const chat = target.value;
            const index = locateMessage(chat, op.index, op.before);
            if (index < 0) return fail(`Сообщение #${op.index} изменилось после анализа`);
            setMessageText(chat.messages[index], op.after);
            applied.index = index;
            return applied;
        }
        case 'chat.setHidden': {
            const chat = target.value;
            const max = Math.max(...op.indices);
            if (max >= chat.messages.length) return fail('В чате стало меньше сообщений, чем при анализе');
            applied.before = op.indices.map(i => Boolean(chat.messages[i].is_system));
            op.indices.forEach((i, k) => {
                const message = chat.messages[i];
                if (message.__raw !== undefined) return;
                message.is_system = Boolean(op.after[k]);
            });
            return applied;
        }
        case 'chat.setMeta': {
            const chat = target.value;
            if (!chat.header) return fail('У чата нет заголовка с метаданными');
            chat.header.chat_metadata = chat.header.chat_metadata || {};
            const current = chat.header.chat_metadata[op.key];
            // Already the wanted value (e.g. a lorebook bound by an earlier card): nothing to do, nothing to undo.
            if (same(current ?? '', op.after ?? '') && !same(op.before ?? '', op.after ?? '')) return { ...applied, noop: true };
            if (!same(current ?? '', op.before ?? '')) return fail(`Поле «${op.key}» изменилось после анализа`);
            if (op.after === null || op.after === undefined) delete chat.header.chat_metadata[op.key];
            else chat.header.chat_metadata[op.key] = op.after;
            return applied;
        }
        case 'chat.setMemory': {
            const chat = target.value;
            const message = chat.messages[op.index];
            if (!message || message.__raw !== undefined) return fail('Сообщение для резюме не найдено');
            const current = message.extra?.memory ?? '';
            if (!same(current, op.before ?? '')) return fail('Резюме изменилось после анализа');
            message.extra = message.extra || {};
            if (op.after) message.extra.memory = op.after;
            else delete message.extra.memory;
            return applied;
        }
        case 'world.addEntry': {
            const world = target.value;
            const uid = Number.isInteger(op.uid) && !world.data.entries[op.uid] ? op.uid : freeUid(world);
            const entry = makeEntry(uid, op.entry);
            world.data.entries[uid] = entry;
            applied.uid = uid;
            applied.entry = entry;
            return applied;
        }
        case 'world.updateEntry': {
            const world = target.value;
            const entry = world.data.entries[op.uid];
            if (!entry) return fail(`Запись #${op.uid} больше не существует`);
            for (const [field, value] of Object.entries(op.before || {})) {
                if (!same(entry[field], value)) return fail(`Запись «${entryLabel(entry)}» изменилась после анализа`);
            }
            Object.assign(entry, structuredClone(op.after));
            return applied;
        }
        case 'world.deleteEntry': {
            const world = target.value;
            const entry = world.data.entries[op.uid];
            if (!entry) return fail(`Запись #${op.uid} уже удалена`);
            if (!same(entry.content, op.before?.content) || !same(entry.key, op.before?.key)) {
                return fail(`Запись «${entryLabel(entry)}» изменилась после анализа`);
            }
            applied.before = structuredClone(entry);
            delete world.data.entries[op.uid];
            return applied;
        }
        case 'world.restoreEntry': {
            const world = target.value;
            if (world.data.entries[op.uid]) return fail(`Номер записи #${op.uid} уже занят`);
            world.data.entries[op.uid] = structuredClone(op.entry);
            return applied;
        }
        case 'card.setField': {
            const card = target.value.card;
            const current = getCardField(card, op.field);
            if (current !== (op.before ?? '')) return fail(`Поле «${op.field}» карточки изменилось после анализа`);
            setCardField(card, op.field, op.after);
            return applied;
        }
        default:
            return fail(`Неизвестная операция ${op.op}`);
    }
}

async function writeTarget(target) {
    if (target.type === 'chat') return writeChat(target.value);
    if (target.type === 'world') return writeWorld(target.value);
    return writeCard(target.value);
}

async function restoreOriginal(target) {
    if (target.original === null) {
        await fs.promises.rm(target.path, { force: true });
    } else {
        await fs.promises.writeFile(target.path, target.original);
    }
}

/**
 * Applies ops to their files. Before writing anything the current files are
 * copied into backups/<id>/. If a write fails midway, files already written
 * are put back.
 * @returns {Promise<{backupId: string, appliedOps: object[]}>}
 */
export async function applyOps(ctx, store, ops, meta = {}) {
    if (!Array.isArray(ops) || ops.length === 0) throw httpError(400, 'Нет изменений для применения');

    const groups = new Map();
    for (const op of ops) {
        const key = targetKey(op);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(op);
    }

    const keys = [...groups.keys()].sort();
    // Lock every file we touch, in a stable order.
    const run = async (i) => {
        if (i < keys.length) return withLock(`file:${ctx.handle}:${keys[i]}`, () => run(i + 1));
        return applyLocked(ctx, store, groups, ops, meta);
    };
    return run(0);
}

async function applyLocked(ctx, store, groups, ops, meta) {
    const targets = new Map();
    for (const [key, list] of groups) {
        targets.set(key, await loadTarget(ctx, key, list));
    }

    const problems = [];
    const appliedOps = [];
    for (const op of ops) {
        const result = checkAndApply(targets.get(targetKey(op)), op, problems);
        if (result) appliedOps.push(result);
    }
    if (problems.length) {
        throw httpError(409, problems.map(p => p.text).join('; '), { problems });
    }

    const backupId = `${Date.now()}-${newId()}`;
    const backupDir = store.backupPath(backupId);
    await fs.promises.mkdir(backupDir, { recursive: true });
    const files = [];
    let n = 0;
    for (const target of targets.values()) {
        const copy = target.original === null ? null : `${n++}-${path.basename(target.path)}`;
        if (copy) await fs.promises.writeFile(path.join(backupDir, copy), target.original);
        files.push({
            type: target.type,
            ref: target.ref,
            path: path.relative(ctx.dirs.root, target.path),
            copy,
            hashBefore: target.hash,
            hashAfter: null,
        });
    }

    const written = [];
    try {
        for (const [i, target] of [...targets.values()].entries()) {
            files[i].hashAfter = await writeTarget(target);
            written.push(target);
        }
    } catch (error) {
        for (const target of written) {
            await restoreOriginal(target).catch(() => { });
        }
        throw httpError(500, `Не удалось записать изменения, файлы возвращены как были: ${error.message}`);
    }

    for (const target of targets.values()) markTouched(ctx.handle, target.type, target.ref);

    await writeJson(path.join(backupDir, 'manifest.json'), {
        id: backupId,
        createdAt: nowIso(),
        proposalId: meta.proposalId ?? null,
        title: meta.title ?? '',
        files,
    });
    pruneBackups(store).catch(() => { });
    return { backupId, appliedOps };
}

/** The exact opposite of each applied op, in reverse order. */
export function inverseOps(appliedOps) {
    return appliedOps.filter(op => !op.noop).reverse().map(op => {
        switch (op.op) {
            case 'chat.setMessage':
            case 'chat.setMeta':
            case 'chat.setMemory':
            case 'card.setField':
                return { ...op, before: op.after, after: op.before };
            case 'chat.setHidden':
                return { ...op, before: op.after, after: op.before };
            case 'world.updateEntry':
                return { ...op, before: op.after, after: op.before };
            case 'world.addEntry':
                return { op: 'world.deleteEntry', world: op.world, uid: op.uid, before: op.entry };
            case 'world.deleteEntry':
                return { op: 'world.restoreEntry', world: op.world, uid: op.uid, entry: op.before };
            case 'world.restoreEntry':
                return { op: 'world.deleteEntry', world: op.world, uid: op.uid, before: op.entry };
            default:
                throw httpError(400, `Нельзя откатить ${op.op}`);
        }
    });
}

export async function readBackup(store, backupId) {
    const dir = store.backupPath(String(backupId).replace(/[^0-9a-z-]/gi, ''));
    const manifest = await readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw httpError(404, 'Резервная копия не найдена');
    return { dir, manifest };
}

/** Puts files back exactly as they were in the backup (used when a precise undo is not possible). */
export async function restoreBackup(ctx, store, backupId) {
    const { dir, manifest } = await readBackup(store, backupId);
    // Save the current state first, so even this step can be undone by hand.
    const safety = `${Date.now()}-${newId()}`;
    const safetyDir = store.backupPath(safety);
    await fs.promises.mkdir(safetyDir, { recursive: true });
    const safetyFiles = [];
    let n = 0;
    for (const file of manifest.files) {
        const full = path.join(ctx.dirs.root, file.path);
        if (!isInside(ctx.dirs.root, full)) throw httpError(400, 'Недопустимый путь в резервной копии');
        await withLock(`file:${ctx.handle}:${file.type}:${file.ref}`, async () => {
            let current = null;
            try {
                current = await fs.promises.readFile(full);
            } catch {
                current = null;
            }
            const copy = current === null ? null : `${n++}-${path.basename(full)}`;
            if (copy) await fs.promises.writeFile(path.join(safetyDir, copy), current);
            safetyFiles.push({ ...file, copy, hashBefore: current ? sha256(current) : null, hashAfter: null });
            if (file.copy === null) {
                await fs.promises.rm(full, { force: true });
            } else {
                await fs.promises.writeFile(full, await fs.promises.readFile(path.join(dir, file.copy)));
            }
            markTouched(ctx.handle, file.type, file.ref);
        });
    }
    await writeJson(path.join(safetyDir, 'manifest.json'), {
        id: safety,
        createdAt: nowIso(),
        proposalId: manifest.proposalId,
        title: `Состояние перед восстановлением копии ${backupId}`,
        files: safetyFiles,
    });
    return { safetyBackupId: safety };
}

async function pruneBackups(store) {
    let entries = [];
    try {
        entries = await fs.promises.readdir(store.backupsDir);
    } catch {
        return;
    }
    const sorted = entries.filter(name => /^\d+-/.test(name)).sort();
    const extra = sorted.length - MAX_BACKUPS;
    for (let i = 0; i < extra; i++) {
        await fs.promises.rm(path.join(store.backupsDir, sorted[i]), { recursive: true, force: true });
    }
}

/** Human-readable view of an op for the app: a label plus before/after text to diff. */
export function describeOp(op, context = {}) {
    switch (op.op) {
        case 'chat.setMessage':
            return { label: `Сообщение #${op.index}${op.speaker ? ` · ${op.speaker}` : ''}`, before: op.before, after: op.after, editable: true };
        case 'chat.setHidden': {
            const hide = op.after.filter(Boolean).length;
            const from = Math.min(...op.indices);
            const to = Math.max(...op.indices);
            return {
                label: hide ? `Скрыть из контекста сообщения #${from}–${to}` : `Вернуть в контекст сообщения #${from}–${to}`,
                note: 'Сообщения остаются в чате, модель их просто не видит. Вернуть: /unhide в SillyTavern или откат здесь',
            };
        }
        case 'chat.setMeta': {
            const names = { note_prompt: 'Заметка автора', world_info: 'Лорбук чата' };
            return { label: names[op.key] ?? `Метаданные чата · ${op.key}`, before: String(op.before ?? ''), after: String(op.after ?? ''), editable: typeof op.after === 'string' };
        }
        case 'chat.setMemory':
            return { label: 'Резюме чата (расширение Summarize)', before: op.before ?? '', after: op.after ?? '', editable: true };
        case 'world.addEntry':
            return {
                label: `Новая запись в лорбуке «${op.world}»${op.create ? ' (лорбук будет создан)' : ''}`,
                keys: op.entry.key,
                before: '',
                after: op.entry.content,
                editable: true,
            };
        case 'world.updateEntry': {
            const view = { label: `Запись «${context.label ?? op.uid}» в лорбуке «${op.world}»` };
            if ('key' in (op.after || {})) {
                view.keysBefore = op.before?.key ?? [];
                view.keys = op.after.key;
            }
            if ('content' in (op.after || {})) {
                view.before = op.before?.content ?? '';
                view.after = op.after.content;
                view.editable = true;
            }
            return view;
        }
        case 'world.deleteEntry':
            return { label: `Удалить запись «${entryLabel(op.before || { uid: op.uid })}» из лорбука «${op.world}»`, before: op.before?.content ?? '', after: '' };
        case 'card.setField':
            return { label: `Карточка «${context.cardName ?? op.avatar}» · ${fieldTitle(op.field)}`, before: op.before ?? '', after: op.after ?? '', editable: true };
        default:
            return { label: op.op };
    }
}

export function fieldTitle(field) {
    return {
        description: 'описание',
        personality: 'характер',
        scenario: 'сценарий',
        first_mes: 'первое сообщение',
        mes_example: 'примеры диалогов',
        system_prompt: 'системный промпт',
        post_history_instructions: 'инструкции после истории',
        creator_notes: 'заметки автора карточки',
        depth_prompt: 'промпт на глубине',
    }[field] ?? field;
}

/** Applies user edits from the app ("after" text changed by hand) to editable ops. */
export function withOverrides(ops, overrides) {
    if (!overrides || typeof overrides !== 'object') return ops;
    return ops.map((op, i) => {
        const text = overrides[i];
        if (typeof text !== 'string') return op;
        switch (op.op) {
            case 'chat.setMessage':
            case 'chat.setMemory':
            case 'card.setField':
                return { ...op, after: text };
            case 'chat.setMeta':
                return typeof op.after === 'string' ? { ...op, after: text } : op;
            case 'world.addEntry':
                return { ...op, entry: { ...op.entry, content: text } };
            case 'world.updateEntry':
                return 'content' in (op.after || {}) ? { ...op, after: { ...op.after, content: text } } : op;
            default:
                return op;
        }
    });
}

export { cardName };
