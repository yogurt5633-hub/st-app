import { entriesOf, entryLabel } from '../worlds.mjs';
import { words } from '../chat-context.mjs';
import { estimateTokens } from '../tokens.mjs';
import { fingerprint, makeProposal } from '../proposals.mjs';
import { truncate, uniq } from '../util.mjs';

const STOP_KEYS = new Set([
    'он', 'она', 'оно', 'они', 'я', 'ты', 'мы', 'вы', 'и', 'а', 'но', 'в', 'на', 'с', 'к', 'по', 'это', 'что', 'как', 'да', 'нет', 'его', 'её', 'ее', 'их',
    'he', 'she', 'it', 'they', 'i', 'you', 'we', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'his', 'her', 'him', 'them', 'yes', 'no', 'user', 'char', '{{user}}', '{{char}}',
]);

function isRegexKey(key) {
    return /^\/.+\/[a-z]*$/i.test(key);
}

function regexError(key) {
    const match = key.match(/^\/(.+)\/([a-z]*)$/i);
    if (!match) return null;
    try {
        new RegExp(match[1], match[2]);
        return null;
    } catch (error) {
        return error.message;
    }
}

/** Returns a cleaned key list and the reasons for each change. */
export function cleanKeys(keys) {
    const reasons = [];
    const result = [];
    const seen = new Set();
    for (const raw of Array.isArray(keys) ? keys : []) {
        if (typeof raw !== 'string') continue;
        const key = raw.trim().replace(/[,;]+$/, '');
        if (!key) {
            reasons.push('пустой ключ');
            continue;
        }
        if (key !== raw) reasons.push(`лишние пробелы или знаки в «${raw}»`);
        if (isRegexKey(key)) {
            const error = regexError(key);
            if (error) {
                reasons.push(`ошибка в регулярном выражении «${key}»`);
                continue;
            }
        } else {
            const lower = key.toLowerCase();
            if (STOP_KEYS.has(lower)) {
                reasons.push(`«${key}» срабатывает почти в каждом сообщении`);
                continue;
            }
            if ([...lower].length <= 2 && /^[\p{L}\p{N}]+$/u.test(lower)) {
                reasons.push(`«${key}» слишком короткий и совпадает с частями слов`);
                continue;
            }
        }
        const norm = key.toLowerCase();
        if (seen.has(norm)) {
            reasons.push(`повтор ключа «${key}»`);
            continue;
        }
        seen.add(norm);
        result.push(key);
    }
    return { keys: result, reasons: uniq(reasons) };
}

function shingleSet(text) {
    const tokens = words(text);
    const set = new Set();
    for (let i = 0; i + 3 <= tokens.length; i++) set.add(tokens.slice(i, i + 3).join(' '));
    if (!set.size && tokens.length) set.add(tokens.join(' '));
    return set;
}

function similarity(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

const keySet = (entry) => (Array.isArray(entry.key) ? entry.key : []).map(k => String(k).trim().toLowerCase()).filter(Boolean).sort().join('|');

export function analyzeDuplicates(world) {
    const entries = entriesOf(world).filter(e => !e.disable);
    const sets = new Map(entries.map(e => [e.uid, shingleSet(e.content)]));
    const proposals = [];
    const used = new Set();
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i];
            const b = entries[j];
            if (used.has(a.uid) || used.has(b.uid)) continue;
            const sameKeys = keySet(a) && keySet(a) === keySet(b);
            const sim = similarity(sets.get(a.uid), sets.get(b.uid));
            const sameText = String(a.content ?? '').trim() === String(b.content ?? '').trim() && String(a.content ?? '').trim() !== '';
            if (!sameText && sim < 0.75 && !sameKeys) continue;
            used.add(a.uid);
            used.add(b.uid);

            // Keep the fuller entry, give it all keys, remove the other one.
            const [keep, drop] = String(a.content ?? '').length >= String(b.content ?? '').length ? [a, b] : [b, a];
            const mergedKeys = uniq([...(keep.key || []), ...(drop.key || [])].map(k => String(k).trim()).filter(Boolean));
            const mergedSecondary = uniq([...(keep.keysecondary || []), ...(drop.keysecondary || [])].map(k => String(k).trim()).filter(Boolean));
            const nearSame = sameText || sim >= 0.75;
            const base = {
                kind: 'lore_duplicate',
                severity: 'low',
                target: { type: 'world', world: world.name, label: world.name },
                fingerprint: fingerprint('lore_duplicate', world.name, [keep.uid, drop.uid].sort(), keep.content, drop.content),
                evidence: [
                    { label: entryLabel(keep), text: truncate(keep.content, 220) },
                    { label: entryLabel(drop), text: truncate(drop.content, 220) },
                ],
            };
            if (nearSame) {
                proposals.push(makeProposal({
                    ...base,
                    title: `Дубль в лорбуке «${world.name}»`,
                    summary: sameText
                        ? `Записи «${entryLabel(keep)}» и «${entryLabel(drop)}» одинаковые и попадают в промпт дважды. Оставлю одну с ключами обеих`
                        : `Записи «${entryLabel(keep)}» и «${entryLabel(drop)}» почти совпадают (${Math.round(sim * 100)}%). Оставлю более полную с ключами обеих`,
                    ops: [
                        { op: 'world.updateEntry', world: world.name, uid: keep.uid, before: { key: keep.key, keysecondary: keep.keysecondary }, after: { key: mergedKeys, keysecondary: mergedSecondary } },
                        { op: 'world.deleteEntry', world: world.name, uid: drop.uid, before: structuredClone(drop) },
                    ],
                    context: { label: entryLabel(keep) },
                }));
            } else {
                proposals.push(makeProposal({
                    ...base,
                    title: `Две записи с одинаковыми ключами в «${world.name}»`,
                    summary: `Записи «${entryLabel(keep)}» и «${entryLabel(drop)}» срабатывают на одни и те же слова, но текст у них разный. Модель может свести их в одну запись без потери фактов`,
                    prepare: { type: 'mergeEntries', world: world.name, uids: [keep.uid, drop.uid] },
                }));
            }
        }
    }
    return proposals;
}

export function analyzeKeys(world) {
    const ops = [];
    const evidence = [];
    const noKeys = [];
    for (const entry of entriesOf(world)) {
        if (entry.disable || entry.constant || entry.vectorized) continue;
        const keys = Array.isArray(entry.key) ? entry.key : [];
        const { keys: cleaned, reasons } = cleanKeys(keys);
        if (!cleaned.length) {
            noKeys.push(entry);
            continue;
        }
        if (!reasons.length) continue;
        ops.push({ op: 'world.updateEntry', world: world.name, uid: entry.uid, before: { key: keys }, after: { key: cleaned } });
        evidence.push({ label: entryLabel(entry), text: reasons.join('; ') });
    }

    const proposals = [];
    if (ops.length) {
        proposals.push(makeProposal({
            kind: 'lore_keys',
            severity: 'low',
            title: `Плохие ключи в лорбуке «${world.name}»`,
            summary: `В ${ops.length} ${plural(ops.length, 'записи', 'записях', 'записях')} есть ключи, которые срабатывают слишком часто, никогда не срабатывают или повторяются. Почищу их`,
            evidence: evidence.slice(0, 8),
            target: { type: 'world', world: world.name, label: world.name },
            fingerprint: fingerprint('lore_keys', world.name, ops.map(op => [op.uid, op.before.key])),
            ops,
            views: ops.map(op => ({
                label: `Ключи записи «${entryLabel(world.data.entries[op.uid])}»`,
                keysBefore: op.before.key,
                keys: op.after.key,
            })),
        }));
    }
    if (noKeys.length) {
        proposals.push(makeProposal({
            kind: 'lore_keys',
            severity: 'medium',
            title: `Записи без рабочих ключей в «${world.name}»`,
            summary: noKeys.length === 1
                ? 'Одна запись не срабатывает: у неё нет ключей или все ключи негодные. Модель подберёт ключи по тексту записи'
                : `${noKeys.length} ${plural(noKeys.length, 'запись не срабатывает', 'записи не срабатывают', 'записей не срабатывают')}: у них нет ключей или все ключи негодные. Модель подберёт ключи по тексту записей`,
            evidence: noKeys.slice(0, 6).map(e => ({ label: entryLabel(e), text: truncate(e.content, 160) })),
            target: { type: 'world', world: world.name, label: world.name },
            fingerprint: fingerprint('lore_nokeys', world.name, noKeys.map(e => [e.uid, e.key])),
            prepare: { type: 'suggestKeys', world: world.name, uids: noKeys.slice(0, 10).map(e => e.uid) },
        }));
    }
    return proposals;
}

export function analyzeLoreBloat(world, settings) {
    const big = entriesOf(world)
        .filter(e => !e.disable && e.constant)
        .map(e => ({ entry: e, tokens: estimateTokens(e.content) }))
        .filter(x => x.tokens > settings.thresholds.entryTokens)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5);
    if (!big.length) return [];
    const total = big.reduce((sum, x) => sum + x.tokens, 0);
    return [makeProposal({
        kind: 'lore_bloat',
        severity: total > 3000 ? 'medium' : 'low',
        title: `Тяжёлые постоянные записи в «${world.name}»`,
        summary: `Постоянные записи попадают в каждый запрос. ${big.length} из них занимают ≈${total.toLocaleString('ru-RU')} токенов. Модель может сжать их без потери фактов`,
        evidence: big.map(x => ({ label: `≈${x.tokens.toLocaleString('ru-RU')} т.`, text: entryLabel(x.entry) })),
        target: { type: 'world', world: world.name, label: world.name },
        fingerprint: fingerprint('lore_bloat', world.name, big.map(x => [x.entry.uid, x.entry.content])),
        prepare: { type: 'condenseEntries', world: world.name, uids: big.map(x => x.entry.uid) },
    })];
}

export function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}
