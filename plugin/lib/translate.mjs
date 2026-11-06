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
export async function translateText(llm, text, lang, { key = null, signal = null, context = '' } = {}) {
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
    const prompt = whole && whole.trim() !== source.trim()
        ? `${system}\n\nТекст пользователя — часть длинного сообщения. Ниже всё сообщение целиком, только чтобы понимать, кто говорит, имена, пол и время. Не переводи его и не включай в ответ: переведи только текст пользователя.\n<<<СООБЩЕНИЕ ЦЕЛИКОМ\n${whole}\nСООБЩЕНИЕ ЦЕЛИКОМ>>>`
        : system;
    // Room for the whole translation, and for the thinking of reasoning models.
    const maxTokens = Math.min(16000, 2000 + source.length * 2);
    const started = Date.now();
    let reply;
    let via;
    if (key) {
        reply = await completeWithKey(key, { system: prompt, user: source, maxTokens, signal, strip: false });
        via = 'key';
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
