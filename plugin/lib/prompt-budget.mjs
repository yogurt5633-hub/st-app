import { estimateTokens } from './tokens.mjs';
import { messageText, isVisible } from './chats.mjs';
import { getCardField } from './cards.mjs';
import { entriesOf, entryLabel } from './worlds.mjs';

// What a request to the model is made of, estimated from SillyTavern's own
// settings: preset prompts, persona, card, lorebooks (constant and triggered by
// keys, with SillyTavern's budget and recursion), memory, notes, history,
// reasoning, vector memory and HTML inside messages.

const CARD_PARTS = [
    ['description', 'Описание персонажа'],
    ['personality', 'Характер'],
    ['scenario', 'Сценарий'],
    ['mes_example', 'Примеры диалогов'],
    ['system_prompt', 'Системный промпт карточки'],
    ['post_history_instructions', 'Инструкции после истории (карточка)'],
    ['depth_prompt', 'Заметка персонажа на глубине'],
];

const PERSONA_NONE = 9;

/** Enabled prompts of the current Chat Completion preset, in SillyTavern's order. */
export function presetPrompts(stSettings) {
    const oai = stSettings?.oai_settings || {};
    const prompts = Array.isArray(oai.prompts) ? oai.prompts : [];
    const orders = Array.isArray(oai.prompt_order) ? oai.prompt_order : [];
    const order = (orders.find(o => Number(o.character_id) === 100001) || orders.find(o => Number(o.character_id) === 100000) || orders[0])?.order || [];
    const enabled = new Map(order.map(o => [o.identifier, o.enabled !== false]));
    return prompts
        .filter(p => p && !p.marker && typeof p.content === 'string' && p.content.trim())
        .filter(p => enabled.get(p.identifier) === true)
        .map(p => ({ identifier: p.identifier, name: p.name || p.identifier, content: p.content, tokens: estimateTokens(p.content) }));
}

export function presetName(stSettings) {
    return stSettings?.oai_settings?.preset_settings_openai || '';
}

// ---------- lorebook activation, same rules as SillyTavern ----------

function parseRegexKey(key) {
    const match = String(key).match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (!match) return null;
    try {
        return new RegExp(match[1], match[2]);
    } catch {
        return null;
    }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keyMatches(key, haystack, entry, opts) {
    const regex = parseRegexKey(key);
    if (regex) return regex.test(haystack);
    const caseSensitive = entry.caseSensitive ?? opts.caseSensitive;
    const text = caseSensitive ? haystack : haystack.toLowerCase();
    const needle = (caseSensitive ? String(key) : String(key).toLowerCase()).trim();
    if (!needle) return false;
    const whole = entry.matchWholeWords ?? opts.wholeWords;
    if (whole && needle.split(/\s+/).length === 1) {
        // Like SillyTavern: non-unicode \W, so Cyrillic word endings still match.
        return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(text);
    }
    return text.includes(needle);
}

function entryMatches(entry, haystack, opts) {
    const keys = (Array.isArray(entry.key) ? entry.key : []).filter(k => String(k).trim());
    if (!keys.length || !keys.some(k => keyMatches(k, haystack, entry, opts))) return false;
    const secondary = (Array.isArray(entry.keysecondary) ? entry.keysecondary : []).filter(k => String(k).trim());
    if (entry.selective === false || !secondary.length) return true;
    const hits = secondary.map(k => keyMatches(k, haystack, entry, opts));
    switch (Number(entry.selectiveLogic ?? 0)) {
        case 1: return !hits.every(Boolean); // NOT_ALL
        case 2: return !hits.some(Boolean); // NOT_ANY
        case 3: return hits.every(Boolean); // AND_ALL
        default: return hits.some(Boolean); // AND_ANY
    }
}

function passesCharacterFilter(entry, avatars) {
    const names = entry.characterFilter?.names;
    if (!Array.isArray(names) || !names.length) return true;
    const ids = avatars.map(a => a.replace(/\.png$/i, ''));
    const listed = names.some(n => ids.includes(String(n).replace(/\.png$/i, '')));
    return entry.characterFilter.isExclude ? !listed : listed;
}

/**
 * Which lorebook entries get into the prompt for the latest message.
 * @returns {{ included: object[], dropped: object[], budget: number, tokens: number }}
 */
export function simulateWorldInfo({ worlds, chat, stSettings, avatars = [], contextSize = 0 }) {
    const wis = stSettings?.world_info_settings || {};
    const opts = {
        caseSensitive: Boolean(wis.world_info_case_sensitive),
        wholeWords: wis.world_info_match_whole_words !== false,
    };
    const defaultDepth = Number.isFinite(Number(wis.world_info_depth)) ? Number(wis.world_info_depth) : 2;
    const includeNames = wis.world_info_include_names !== false;
    const recursive = wis.world_info_recursive !== false;
    const steps = Number(wis.world_info_max_recursion_steps) || 5;
    let budget = contextSize ? Math.round((Number(wis.world_info_budget ?? 25) / 100) * contextSize) : Infinity;
    if (Number(wis.world_info_budget_cap) > 0) budget = Math.min(budget, Number(wis.world_info_budget_cap));

    const recent = chat.messages.filter(isVisible).reverse();
    const bufferCache = new Map();
    const buffer = (depth) => {
        if (!bufferCache.has(depth)) {
            bufferCache.set(depth, recent.slice(0, Math.max(0, depth))
                .map(m => (includeNames && m.name ? `${m.name}: ${messageText(m)}` : messageText(m)))
                .join('\n'));
        }
        return bufferCache.get(depth);
    };

    const all = [];
    for (const world of worlds) {
        for (const entry of entriesOf(world)) {
            if (entry.disable || !String(entry.content ?? '').trim()) continue;
            if (!passesCharacterFilter(entry, avatars)) continue;
            all.push({ world: world.name, entry, tokens: estimateTokens(entry.content), label: entryLabel(entry) });
        }
    }

    const active = new Map();
    const id = (x) => `${x.world}:${x.entry.uid}`;
    for (const x of all) {
        if (x.entry.constant) {
            active.set(id(x), { ...x, reason: 'constant' });
        } else if (!x.entry.delayUntilRecursion && entryMatches(x.entry, buffer(Number(x.entry.scanDepth ?? defaultDepth)), opts)) {
            active.set(id(x), { ...x, reason: 'key' });
        }
    }
    if (recursive) {
        for (let step = 0; step < steps; step++) {
            const text = [...active.values()].filter(x => !x.entry.preventRecursion).map(x => x.entry.content).join('\n');
            let added = 0;
            for (const x of all) {
                if (active.has(id(x)) || x.entry.excludeRecursion) continue;
                if (entryMatches(x.entry, text, opts)) {
                    active.set(id(x), { ...x, reason: 'recursion' });
                    added++;
                }
            }
            if (!added) break;
        }
    }

    // Inclusion groups: one entry per group gets in.
    const grouped = new Map();
    const dropped = [];
    for (const x of active.values()) {
        const groups = String(x.entry.group || '').split(/,\s*/).filter(Boolean);
        for (const g of groups) {
            const prev = grouped.get(g);
            const better = !prev || (x.entry.groupOverride && !prev.entry.groupOverride) || (Number(x.entry.order ?? 100) > Number(prev.entry.order ?? 100));
            if (better) {
                if (prev) dropped.push({ ...prev, why: 'group' });
                grouped.set(g, x);
            } else {
                dropped.push({ ...x, why: 'group' });
            }
        }
    }
    const droppedIds = new Set(dropped.map(id));
    const sorted = [...active.values()].filter(x => !droppedIds.has(id(x)))
        .sort((a, b) => (b.reason === 'constant') - (a.reason === 'constant') || Number(b.entry.order ?? 100) - Number(a.entry.order ?? 100));

    const included = [];
    let used = 0;
    for (const x of sorted) {
        if (!x.entry.ignoreBudget && used + x.tokens > budget) {
            dropped.push({ ...x, why: 'budget' });
            continue;
        }
        included.push(x);
        used += x.tokens;
    }
    return { included, dropped, budget, tokens: used };
}

// ---------- the rest of the prompt ----------

/** Global regex scripts that clean AI messages only in the prompt (e.g. stripping HTML). */
function promptRegexes(stSettings) {
    const disabled = stSettings?.extension_settings?.disabledExtensions;
    if (Array.isArray(disabled) && disabled.includes('regex')) return [];
    const scripts = stSettings?.extension_settings?.regex;
    if (!Array.isArray(scripts)) return [];
    return scripts
        .filter(s => s && !s.disabled && !s.markdownOnly && Array.isArray(s.placement) && s.placement.includes(2))
        .map(s => ({ re: parseRegexKey(s.findRegex), replace: String(s.replaceString ?? '').replace(/\{\{match\}\}/g, '$&'), minDepth: Number.isFinite(s.minDepth) ? s.minDepth : null, maxDepth: Number.isFinite(s.maxDepth) ? s.maxDepth : null }))
        .filter(s => s.re);
}

export function markupTokens(text) {
    const value = String(text ?? '');
    const withoutStyles = value.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '');
    const plain = withoutStyles.replace(/<[^>]+>/g, '');
    return Math.max(0, estimateTokens(value) - estimateTokens(plain));
}

/** Full estimate for one chat. cc comes from buildChatContext(). */
export function promptBudget(cc, stSettings) {
    const { chat } = cc;
    const items = [];
    const add = (group, label, tokens, extra = {}) => {
        if (tokens > 0) items.push({ group, label, tokens: Math.round(tokens), ...extra });
    };
    const conn = cc.conn;
    const isChat = conn.api !== 'text';

    // Preset / system prompt
    if (isChat) {
        for (const p of presetPrompts(stSettings)) add('preset', `Пресет: ${p.name}`, p.tokens, { identifier: p.identifier });
    } else {
        const sys = stSettings?.power_user?.sysprompt;
        if (sys?.enabled !== false && sys?.content) add('preset', `Системный промпт: ${sys.name || ''}`.trim(), estimateTokens(sys.content));
    }

    // Persona
    const pu = stSettings?.power_user || {};
    if (pu.persona_description && Number(pu.persona_description_position) !== PERSONA_NONE) {
        add('persona', 'Описание персоны', estimateTokens(pu.persona_description));
    }

    // Card (the speaking character in a group: take the biggest)
    const card = cc.cards.slice().sort((a, b) => estimateTokens(getCardField(b.card, 'description')) - estimateTokens(getCardField(a.card, 'description')))[0];
    if (card) {
        for (const [field, label] of CARD_PARTS) add('card', label, estimateTokens(getCardField(card.card, field)), { field, avatar: card.avatar });
    }

    // Lorebooks
    const wi = simulateWorldInfo({ worlds: cc.worlds, chat, stSettings, avatars: cc.cards.map(c => c.avatar), contextSize: conn.contextSize });
    const constant = wi.included.filter(x => x.reason === 'constant');
    const keyed = wi.included.filter(x => x.reason !== 'constant');
    add('lore', `Лорбук: постоянные записи (${constant.length})`, constant.reduce((s, x) => s + x.tokens, 0));
    add('lore', `Лорбук: сработали по ключам (${keyed.length})`, keyed.reduce((s, x) => s + x.tokens, 0));

    // Memory and notes
    const meta = chat.header?.chat_metadata || {};
    let memory = null;
    for (let i = chat.messages.length - 2; i >= 0; i--) {
        if (chat.messages[i]?.extra?.memory) {
            memory = chat.messages[i].extra.memory;
            break;
        }
    }
    const summarizeOff = Array.isArray(stSettings?.extension_settings?.disabledExtensions) && stSettings.extension_settings.disabledExtensions.includes('memory');
    if (memory && !summarizeOff) add('memory', 'Резюме (Summarize)', estimateTokens(memory));
    if (meta.note_prompt && meta.note_interval !== 0) add('memory', 'Заметка автора', estimateTokens(meta.note_prompt));
    const vectors = stSettings?.extension_settings?.vectors;
    if (vectors?.enabled_chats) {
        const chunk = Number(vectors.message_chunk_size) || 400;
        add('memory', 'Векторная память чата (оценка)', (Number(vectors.insert) || 3) * estimateTokens('х'.repeat(chunk)));
    }

    // History
    const regexes = promptRegexes(stSettings);
    const visible = chat.messages.filter(isVisible);
    let history = 0;
    let markup = 0;
    visible.forEach((m, i) => {
        const depth = visible.length - 1 - i;
        let text = messageText(m);
        if (!m.is_user) {
            for (const r of regexes) {
                if (r.minDepth !== null && r.minDepth >= -1 && depth < r.minDepth) continue;
                if (r.maxDepth !== null && r.maxDepth >= 0 && depth > r.maxDepth) continue;
                text = text.replace(r.re, r.replace);
            }
            markup += markupTokens(text);
        }
        history += estimateTokens(text) + 4;
    });
    add('history', `Сообщения (${visible.length})`, history - markup);
    add('history', 'HTML и разметка в сообщениях', markup, { markup: true });

    const reasoning = pu.reasoning || {};
    if (reasoning.add_to_prompts) {
        const withReasoning = visible.filter(m => m.extra?.reasoning).slice(-Math.max(1, Number(reasoning.max_additions) || 1));
        add('history', `Рассуждения модели в истории (${withReasoning.length})`, withReasoning.reduce((s, m) => s + estimateTokens(m.extra.reasoning), 0), { reasoning: true });
    }

    const budget = Math.max(0, conn.contextSize - conn.responseSize);
    const total = items.reduce((s, x) => s + x.tokens, 0) + 150;
    const fixed = total - items.filter(x => x.group === 'history').reduce((s, x) => s + x.tokens, 0);
    return {
        items: items.sort((a, b) => b.tokens - a.tokens),
        total,
        fixed,
        budget,
        ratio: budget ? total / budget : 0,
        wi: {
            budget: Number.isFinite(wi.budget) ? wi.budget : null,
            tokens: wi.tokens,
            included: wi.included.map(x => ({ world: x.world, uid: x.entry.uid, label: x.label, tokens: x.tokens, reason: x.reason })),
            dropped: wi.dropped.map(x => ({ world: x.world, uid: x.entry.uid, label: x.label, tokens: x.tokens, why: x.why })),
        },
        preset: isChat ? presetName(stSettings) : '',
        visibleCount: visible.length,
        hiddenCount: chat.messages.length - visible.length,
        regexes: regexes.length,
    };
}
