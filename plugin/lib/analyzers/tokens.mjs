import crypto from 'node:crypto';
import { promptBudget, presetPrompts, presetName } from '../prompt-budget.mjs';
import { getCardField } from '../cards.mjs';
import { words } from '../chat-context.mjs';
import { fingerprint, makeProposal } from '../proposals.mjs';
import { truncate } from '../util.mjs';

// Where the tokens go, and what to do about it. Changes that live in files
// (lorebook entries, settings.json, presets) become cards with a fix; the rest
// become advice with exact steps.

export const HTML_REGEX_NAME = 'Корректор: HTML из старых сообщений не отправлять в модель';

const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

function shingles(text) {
    const list = words(text);
    const set = new Set();
    for (let i = 0; i + 4 <= list.length; i++) set.add(list.slice(i, i + 4).join(' '));
    return set;
}

/** Share of the entry's text that already sits in the card. */
function containment(entryText, cardText) {
    const a = shingles(entryText);
    if (a.size < 4) return 0;
    const b = shingles(cardText);
    let inside = 0;
    for (const x of a) if (b.has(x)) inside++;
    return inside / a.size;
}

export function htmlRegexScript() {
    return {
        id: crypto.randomUUID(),
        scriptName: HTML_REGEX_NAME,
        findRegex: '/<(style|script)[^>]*>[\\s\\S]*?<\\/\\1>|<[^>]+>/gi',
        replaceString: '',
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: true,
        runOnEdit: false,
        substituteRegex: 0,
        // The newest two replies keep their markup, so the model still sees the format it should follow.
        minDepth: 2,
        maxDepth: null,
    };
}

const EXTENSION_TIPS = {
    '3_vectors': 'Уменьшите «Insert» или размер кусков в Extensions → Vector Storage (чаты)',
    '4_vectors_data_bank': 'Уменьшите «Retrieve chunks» или размер кусков в Extensions → Vector Storage (Data Bank). Если это CharMemory, можно ещё объединить дубли воспоминаний в нём',
    '1_memory': 'Резюме разрослось. Пересоберите его короче в Extensions → Summarize',
};

export function analyzeTokens(cc, settings, budget = promptBudget(cc, cc.stSettings), actual = null) {
    const st = cc.stSettings || {};
    const out = [];
    const target = { type: 'chat', chatId: cc.chatId, label: cc.title };
    const item = (pred) => budget.items.find(pred);
    const history = budget.items.filter(x => x.group === 'history').reduce((s, x) => s + x.tokens, 0);

    // 1. Heavy prompts in the Chat Completion preset
    if (cc.conn.api !== 'text') {
        const preset = presetName(st);
        for (const p of presetPrompts(st)) {
            if (p.tokens < settings.thresholds.presetPromptTokens) continue;
            out.push(makeProposal({
                kind: 'preset_bloat',
                severity: p.tokens >= 2000 ? 'high' : 'medium',
                title: `Тяжёлый промпт пресета: ${p.name}`,
                summary: `«${p.name}»${preset ? ` из пресета «${preset}»` : ''} уходит в каждый запрос: ≈${fmt(p.tokens)} токенов. Модель может переписать его короче, сохранив все правила`,
                evidence: [{ label: 'Начало промпта', text: truncate(p.content.replace(/\s+/g, ' '), 220) }],
                target,
                fingerprint: fingerprint('preset_bloat', p.identifier, p.content),
                prepare: { type: 'condensePrompt', identifier: p.identifier, preset },
            }));
        }
    } else {
        const sys = st.power_user?.sysprompt;
        const tokens = item(x => x.group === 'preset')?.tokens ?? 0;
        if (sys?.content && tokens >= settings.thresholds.presetPromptTokens) {
            out.push(makeProposal({
                kind: 'advice', advice: true, severity: 'low',
                title: 'Длинный системный промпт',
                summary: `Системный промпт «${sys.name || ''}» занимает ≈${fmt(tokens)} токенов в каждом запросе. Сократите его в SillyTavern: «A» (Advanced Formatting) → System Prompt`,
                target,
                fingerprint: fingerprint('advice_sysprompt', sys.content),
            }));
        }
    }

    // 2. Model reasoning sent back into the prompt
    const reasoning = item(x => x.reasoning);
    if (reasoning && reasoning.tokens >= 300) {
        out.push(makeProposal({
            kind: 'prompt_reasoning',
            severity: 'medium',
            title: 'Рассуждения модели уходят обратно в промпт',
            summary: `В SillyTavern включено «добавлять рассуждения в промпт»: ≈${fmt(reasoning.tokens)} токенов в каждом запросе. Модели они почти никогда не нужны. Выключу эту настройку`,
            target,
            fingerprint: fingerprint('prompt_reasoning'),
            ops: [{
                op: 'settings.setPath',
                path: ['power_user', 'reasoning', 'add_to_prompts'],
                before: true,
                after: false,
                label: 'Добавлять рассуждения в промпт',
                view: { label: 'Настройки SillyTavern · Рассуждения', before: 'Добавлять в промпт: включено', after: 'Добавлять в промпт: выключено', note: 'Рассуждения останутся видны в чате, просто перестанут отправляться модели' },
            }],
        }));
    }

    // 3. HTML and CSS inside the history
    const markup = item(x => x.markup);
    if (markup && markup.tokens >= Math.max(800, history * 0.1)) {
        const regexOff = Array.isArray(st.extension_settings?.disabledExtensions) && st.extension_settings.disabledExtensions.includes('regex');
        const scripts = Array.isArray(st.extension_settings?.regex) ? st.extension_settings.regex : null;
        const exists = scripts?.some(s => s?.scriptName === HTML_REGEX_NAME);
        if (regexOff || !scripts) {
            out.push(makeProposal({
                kind: 'advice', advice: true, severity: 'medium',
                title: 'HTML в сообщениях съедает токены',
                summary: `Разметка в ответах (блоки статуса, стили, таблицы) занимает ≈${fmt(markup.tokens)} токенов. Включите расширение Regex в SillyTavern, и Корректор предложит правило, которое убирает разметку из старых сообщений только в запросе к модели`,
                target,
                fingerprint: fingerprint('advice_html', cc.chatId),
            }));
        } else if (!exists) {
            out.push(makeProposal({
                kind: 'prompt_html',
                severity: markup.tokens >= 3000 ? 'high' : 'medium',
                title: 'HTML в сообщениях съедает токены',
                summary: `Разметка в ответах (блоки статуса, стили, таблицы) занимает ≈${fmt(markup.tokens)} токенов. Добавлю правило Regex: из сообщений старше двух последних теги не отправляются модели. В чате всё останется как было, текст внутри блоков модель тоже увидит`,
                target,
                fingerprint: fingerprint('prompt_html'),
                ops: [{
                    op: 'settings.setPath',
                    path: ['extension_settings', 'regex'],
                    before: scripts,
                    after: [...scripts, htmlRegexScript()],
                    label: 'Регулярные выражения SillyTavern',
                    view: { label: 'Regex · новое правило', before: '', after: `${HTML_REGEX_NAME}\nНайти: <теги и блоки стилей>\nЗаменить на: пусто\nГде: ответы ИИ, только в промпте, начиная с 3-го сообщения с конца`, note: 'Удалить правило можно откатом здесь или в SillyTavern: Extensions → Regex' },
                }],
            }));
        }
    }

    // 4. Lorebook entries that repeat the card
    const card = cc.cards[0]?.card;
    if (card) {
        const cardText = ['description', 'personality', 'scenario'].map(f => getCardField(card, f)).join('\n');
        for (const x of budget.wi.included) {
            const world = cc.worlds.find(w => w.name === x.world);
            const entry = world?.data.entries[x.uid];
            if (!entry || x.tokens < 60) continue;
            const share = containment(entry.content, cardText);
            if (share < 0.6) continue;
            out.push(makeProposal({
                kind: 'lore_card_dup',
                severity: 'low',
                title: `Запись «${x.label}» повторяет карточку`,
                summary: `${Math.round(share * 100)}% текста записи уже есть в карточке персонажа, а запись добавляет ещё ≈${fmt(x.tokens)} токенов. Выключу её (не удаляю, можно включить обратно)`,
                evidence: [{ label: x.label, text: truncate(entry.content, 220) }],
                target: { type: 'world', world: x.world, label: x.world },
                fingerprint: fingerprint('lore_card_dup', x.world, x.uid, entry.content),
                ops: [{
                    op: 'world.updateEntry', world: x.world, uid: x.uid,
                    before: { disable: entry.disable }, after: { disable: true },
                    view: { label: `Запись «${x.label}» в лорбуке «${x.world}»`, before: 'Включена', after: 'Выключена' },
                }],
            }));
        }
    }

    // 5. Big entries triggered by keys in this chat
    const bigKeyed = budget.wi.included.filter(x => x.reason !== 'constant' && x.tokens >= settings.thresholds.entryTokens);
    const byWorld = new Map();
    for (const x of bigKeyed) {
        if (!byWorld.has(x.world)) byWorld.set(x.world, []);
        byWorld.get(x.world).push(x);
    }
    for (const [world, list] of byWorld) {
        const total = list.reduce((s, x) => s + x.tokens, 0);
        out.push(makeProposal({
            kind: 'lore_keyed',
            severity: 'low',
            title: `Тяжёлые записи срабатывают в чате: «${world}»`,
            summary: `Сейчас по ключам срабатывают ${list.length} крупных записей, ≈${fmt(total)} токенов. Модель может сжать их без потери фактов`,
            evidence: list.slice(0, 5).map(x => ({ label: `≈${fmt(x.tokens)} т.`, text: x.label })),
            target: { type: 'world', world, label: world },
            fingerprint: fingerprint('lore_bloat_keyed', world, list.map(x => [x.uid, x.tokens])),
            prepare: { type: 'condenseEntries', world, uids: list.slice(0, 5).map(x => x.uid) },
        }));
    }

    // 6. Advice: things that live in settings the user should decide on
    if (budget.wi.dropped.some(x => x.why === 'budget')) {
        const lost = budget.wi.dropped.filter(x => x.why === 'budget');
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: 'medium',
            title: 'Лорбук не влезает в свой бюджет',
            summary: `${lost.length} сработавших записей (≈${fmt(lost.reduce((s, x) => s + x.tokens, 0))} токенов) не попадут в промпт: бюджет лорбука ≈${fmt(budget.wi.budget)} токенов. Сожмите крупные записи или поднимите бюджет: World Info → Budget`,
            evidence: lost.slice(0, 5).map(x => ({ label: `≈${fmt(x.tokens)} т.`, text: `${x.label} (${x.world})` })),
            target,
            fingerprint: fingerprint('advice_wi_budget', cc.chatId, lost.map(x => x.uid)),
        }));
    }
    const globals = Array.isArray(st.world_info_settings?.world_info?.globalSelect) ? st.world_info_settings.world_info.globalSelect : [];
    for (const name of globals) {
        if (name === cc.chatWorld || name === cc.charWorld) continue;
        const tokens = budget.wi.included.filter(x => x.world === name && x.reason === 'constant').reduce((s, x) => s + x.tokens, 0);
        if (tokens < 400) continue;
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: 'low',
            title: `Глобальный лорбук «${name}» в каждом чате`,
            summary: `Его постоянные записи добавляют ≈${fmt(tokens)} токенов в каждый чат, включая этот. Если он нужен не везде, снимите его с глобальных в World Info и привяжите к нужным персонажам`,
            target,
            fingerprint: fingerprint('advice_global_wi', name),
        }));
    }
    const vectors = item(x => x.label.startsWith('Векторная память'));
    if (vectors && vectors.tokens >= 1000) {
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: 'low',
            title: 'Векторная память добавляет много текста',
            summary: `Каждый запрос получает ≈${fmt(vectors.tokens)} токенов из векторной памяти чата. Уменьшите «Insert» или размер кусков в Extensions → Vector Storage`,
            target,
            fingerprint: fingerprint('advice_vectors', vectors.tokens),
        }));
    }
    const persona = item(x => x.group === 'persona');
    if (persona && persona.tokens >= 500) {
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: 'low',
            title: 'Длинное описание персоны',
            summary: `Описание вашей персоны занимает ≈${fmt(persona.tokens)} токенов в каждом запросе. Сократите его: Persona Management`,
            target,
            fingerprint: fingerprint('advice_persona', persona.tokens),
        }));
    }
    const examples = item(x => x.field === 'mes_example');
    if (examples && examples.tokens >= 800 && st.power_user?.pin_examples) {
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: 'low',
            title: 'Примеры диалогов закреплены в контексте',
            summary: `Примеры диалогов занимают ≈${fmt(examples.tokens)} токенов и закреплены. Обычно они нужны только в начале чата: выключите «Pin example messages» в Advanced Formatting`,
            target,
            fingerprint: fingerprint('advice_examples', cc.chatId),
        }));
    }

    // CharMemory health: memories exist, but nothing brings them into the prompt.
    const cm = cc.charMemory;
    if (cm?.enabled && cm.files?.length && !cm.retrieval) {
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: 'medium',
            title: 'Воспоминания CharMemory не попадают в промпт',
            summary: `У персонажа ${cm.memories?.count ?? 0} воспоминаний в Data Bank, но векторная память для файлов выключена, и модель их не получает. Включите Extensions → Vector Storage → «Enabled for files»`,
            target,
            fingerprint: fingerprint('advice_charmemory_retrieval', cc.cards[0]?.avatar ?? cc.chatId),
        }));
    }

    // 7. Real injections by extensions, from the last request counted by SillyTavern
    for (const x of actual?.extensions || []) {
        if (x.tokens < settings.thresholds.extensionTokens) continue;
        if (x.key === '2_floating_prompt') continue; // the Author's Note is the user's own text
        out.push(makeProposal({
            kind: 'advice', advice: true, severity: x.tokens >= 2000 ? 'medium' : 'low',
            title: `${x.name}: ≈${fmt(x.tokens)} токенов в каждом запросе`,
            summary: `${EXTENSION_TIPS[x.key] ?? 'Если эта вставка не нужна в этом чате, отключите расширение или уменьшите её в его настройках'}. Число посчитал сам SillyTavern на последнем ответе`,
            evidence: x.preview ? [{ label: 'Начало вставки', text: x.preview }] : [],
            target,
            fingerprint: fingerprint('advice_extension', cc.chatId, x.key, Math.round(x.tokens / 500)),
        }));
    }
    return out;
}
