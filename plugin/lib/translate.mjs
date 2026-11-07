// Translation of one chat message with Korrektor's model (task 'translate', the cheap one by default).
// Used by the companion's "Translate chat" when free translators do not answer
// or when the person wants roleplay style kept.

import { stripThinking } from './llm.mjs';
import { completeWithKey } from './translate-key.mjs';
import { httpError } from './util.mjs';

const NAMES = {
    ru: 'русский', en: 'английский', uk: 'украинский', be: 'белорусский', kk: 'казахский',
    ja: 'японский', ko: 'корейский', 'zh-CN': 'китайский (упрощённый)', 'zh-TW': 'китайский (традиционный)',
    de: 'немецкий', fr: 'французский', es: 'испанский', it: 'итальянский', 'pt-BR': 'португальский', pt: 'португальский',
    pl: 'польский', tr: 'турецкий',
};

export const MAX_TRANSLATE_CHARS = 12000;
const MAX_CONTEXT_CHARS = 12000;

export function languageName(code) {
    return NAMES[code] || code;
}

export const MAX_INSTRUCTIONS = 4000;
export const MAX_GLOSSARY = 20000;
const GLOSSARY_SPLIT = /\s*(?:=>|->|→|=|—|–)\s*/;

/**
 * The glossary as the person writes it, one entry per line: «Shadow Whisper = Шёпот Тени»
 * (also →, ->, —). Empty lines and lines starting with # are skipped. «Name =» with nothing
 * after it means: leave as it is. Returns [{ from, to }].
 */
export function parseGlossary(text) {
    const out = [];
    for (const raw of String(text || '').slice(0, MAX_GLOSSARY).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(GLOSSARY_SPLIT);
        if (!match) continue;
        const from = line.slice(0, match.index).trim();
        const to = line.slice(match.index + match[0].length).trim();
        if (from) out.push({ from, to });
    }
    return out.slice(0, 500);
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the text have this term? Whole words, any case. */
export function hasTerm(text, term) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The person's own part of the prompt: their instructions, and the glossary entries that occur in
 * this text (only those: a long glossary does not cost tokens on every message).
 */
export function guidePrompt({ instructions = '', glossary = '' } = {}, text = '') {
    const parts = [];
    const own = String(instructions || '').trim().slice(0, MAX_INSTRUCTIONS);
    if (own) parts.push(`Указания пользователя к переводу — соблюдай их; если они расходятся с правилами выше, следуй указаниям (но отвечай всё равно только переводом):\n${own}`);
    const terms = parseGlossary(glossary).filter(t => hasTerm(text, t.from));
    if (terms.length) {
        parts.push(`Глоссарий — эти слова и имена переводи именно так (склоняй по правилам языка, если нужно; «оставить как есть» — не переводи):\n${terms.map(t => `${t.from} → ${t.to || 'оставить как есть'}`).join('\n')}`);
    }
    return parts.join('\n\n');
}

/** How much the model may think while translating: as little as possible unless chosen otherwise. */
function translateEffort(llm) {
    const chosen = llm?.settings?.models?.translateEffort;
    // 'low' was the default before 'fast' existed.
    return !chosen || chosen === 'low' || chosen === 'fast' ? 'fast' : chosen;
}

/**
 * Translates one message (or one part of it). With the translator's own key (`key`, see
 * translate-key.mjs) the request goes straight to that provider; otherwise through SillyTavern.
 * Returns { text, cut, model, via, ms }: cut = the answer hit the length limit, so its end is missing.
 */
export async function translateText(llm, text, lang, { key = null, signal = null, context = '', onDelta = null, guide = null } = {}) {
    const source = String(text ?? '');
    if (!source.trim()) return { text: '', cut: false, model: '', via: '', ms: 0 };
    if (source.length > MAX_TRANSLATE_CHARS) throw httpError(413, 'Сообщение слишком длинное для перевода моделью');
    const target = languageName(String(lang || 'ru'));
    const system = [
        `Ты переводчик ролевых чатов. Переведи текст пользователя на ${target} язык.`,
        'Сохрани стиль, тон, мат и интимные сцены как есть, без смягчения и без пояснений.',
        'Переведи весь текст целиком, до последней строки: ничего не пропускай, не сокращай и не пересказывай, включая статусы, таблицы, списки и текст внутри блоков кода.',
        'Сохрани разметку: *действия*, "реплики", markdown, переносы строк, HTML-теги с их атрибутами и стилями, {{макросы}} и ссылки — без изменений; переводи только текст между тегами.',
        'Строки и блоки, уже написанные на нужном языке, оставь как есть, символ в символ.',
        'Имена не переводи, а передавай буквами нужного языка, если это принято.',
        'Если текст уже на нужном языке, верни его без изменений.',
        'Ответь только переводом, без кавычек вокруг и без комментариев.',
    ].join(' ');
    // One part of a long message: the whole message comes along to read (who speaks, names, genders, tense).
    const whole = String(context || '').slice(0, MAX_CONTEXT_CHARS);
    const own = guide ? guidePrompt(guide, source) : '';
    let prompt = own ? `${system}\n\n${own}` : system;
    if (whole && whole.trim() !== source.trim()) {
        prompt += `\n\nТекст пользователя — часть длинного сообщения. Ниже всё сообщение целиком, только чтобы понимать, кто говорит, имена, пол и время. Не переводи его и не включай в ответ: переведи только текст пользователя.\n<<<СООБЩЕНИЕ ЦЕЛИКОМ\n${whole}\nСООБЩЕНИЕ ЦЕЛИКОМ>>>`;
    }
    // Room for the whole translation, and for the thinking of reasoning models.
    const maxTokens = Math.min(16000, 2000 + source.length * 2);
    const started = Date.now();
    let reply;
    let via;
    // onDelta: the translation is read as the model writes it (shown in the message as it grows).
    if (key) {
        reply = await completeWithKey(key, { system: prompt, user: source, maxTokens, signal, strip: false, onDelta });
        via = 'key';
    } else if (onDelta && llm.completeStream) {
        reply = await llm.completeStream({ task: 'translate', system: prompt, user: source, maxTokens, effort: translateEffort(llm), strip: false, onDelta, signal });
        via = 'tavern';
    } else {
        reply = await llm.complete({ task: 'translate', system: prompt, user: source, maxTokens, effort: translateEffort(llm), strip: false });
        via = 'tavern';
    }
    // The model's own thinking is cut out, unless the message itself has such tags.
    let out = /<\/?(think|thinking|reasoning)>/i.test(source) ? String(reply.text ?? '').trim() : stripThinking(reply.text);
    // Some models wrap the whole answer in a code fence; a fence the message itself has stays.
    if (/^```/.test(out) && !/^\s*```/.test(source)) {
        out = out.replace(/^```[a-z]*\n?/, '');
        if (!/```\s*$/.test(source)) out = out.replace(/\n?```$/, '');
        out = out.trim();
    }
    return { text: out, cut: Boolean(reply.cut), model: reply.model || '', via, ms: Date.now() - started, usage: reply.usage || null };
}
