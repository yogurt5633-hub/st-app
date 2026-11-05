// Translation of one chat message with Korrektor's model (task 'translate', the cheap one by default).
// Used by the companion's "Translate chat" when free translators do not answer
// or when the person wants roleplay style kept.

import { httpError } from './util.mjs';

const NAMES = {
    ru: 'русский', en: 'английский', uk: 'украинский', be: 'белорусский', kk: 'казахский',
    ja: 'японский', ko: 'корейский', 'zh-CN': 'китайский (упрощённый)', 'zh-TW': 'китайский (традиционный)',
    de: 'немецкий', fr: 'французский', es: 'испанский', it: 'итальянский', 'pt-BR': 'португальский', pt: 'португальский',
    pl: 'польский', tr: 'турецкий',
};

export const MAX_TRANSLATE_CHARS = 12000;

export function languageName(code) {
    return NAMES[code] || code;
}

export async function translateText(llm, text, lang) {
    const source = String(text ?? '');
    if (!source.trim()) return '';
    if (source.length > MAX_TRANSLATE_CHARS) throw httpError(413, 'Сообщение слишком длинное для перевода моделью');
    const target = languageName(String(lang || 'ru'));
    const system = [
        `Ты переводчик ролевых чатов. Переведи текст пользователя на ${target} язык.`,
        'Сохрани стиль, тон, мат и интимные сцены как есть, без смягчения и без пояснений.',
        'Сохрани разметку: *действия*, "реплики", markdown, переносы строк, HTML-теги, {{макросы}} и ссылки — без изменений.',
        'Имена не переводи, а передавай буквами нужного языка, если это принято.',
        'Если текст уже на нужном языке, верни его без изменений.',
        'Ответь только переводом, без кавычек вокруг и без комментариев.',
    ].join(' ');
    const reply = await llm.complete({
        task: 'translate',
        system,
        user: source,
        maxTokens: Math.min(8000, 400 + Math.ceil(source.length / 1.5)),
    });
    return String(reply.text ?? '').replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '').trim();
}
