import { httpError, truncate } from './util.mjs';

// Real numbers of the last request, as SillyTavern itself counted them
// (sent by the companion extension after each reply).

const PART_NAMES = {
    system: 'Системные промпты пресета',
    card: 'Карточка персонажа',
    persona: 'Персона',
    examples: 'Примеры диалогов',
    lorebook: 'Лорбуки',
    history: 'История чата',
    summary: 'Резюме (Summarize)',
    authorsNote: 'Заметка автора',
    chatVectors: 'Векторная память чата',
    dataBank: 'Data Bank (файлы, CharMemory)',
    injections: 'Вставки в чат',
};

export function extensionName(key) {
    const k = String(key);
    if (k === '1_memory') return 'Summarize (резюме)';
    if (k === '2_floating_prompt') return 'Заметка автора';
    if (k === '3_vectors') return 'Векторная память чата';
    if (k === '4_vectors_data_bank') return 'Data Bank (файлы, CharMemory)';
    if (k === 'DEPTH_PROMPT' || k.startsWith('DEPTH_PROMPT_')) return 'Заметка персонажа на глубине';
    if (k.startsWith('customDepthWI')) return 'Лорбук на глубине';
    if (k.startsWith('customWIOutlet_')) return 'Лорбук: outlet';
    if (k === '__STORY_STRING__') return 'Story string';
    if (k.startsWith('script_inject_')) return `Скрипт /inject: ${k.slice('script_inject_'.length)}`;
    if (/summaryception/i.test(k)) return 'Summaryception';
    return `Расширение: ${k}`;
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);

/** Validates what the companion sends, keeping only plain numbers and short strings. */
export function cleanReport(body) {
    const chatId = String(body?.chatId || '');
    if (!/^[cg]\//.test(chatId)) throw httpError(400, 'Неверный chatId');
    const parts = {};
    for (const key of Object.keys(PART_NAMES)) parts[key] = num(body?.parts?.[key]);
    return {
        chatId,
        mesId: num(body?.mesId),
        at: new Date().toISOString(),
        api: truncate(String(body?.api || ''), 40),
        model: truncate(String(body?.model || ''), 120),
        preset: truncate(String(body?.preset || ''), 120),
        tokenizer: truncate(String(body?.tokenizer || ''), 80),
        total: num(body?.total),
        reply: num(body?.replyTokens),
        maxContext: num(body?.maxContext),
        parts,
        extensions: (Array.isArray(body?.extensions) ? body.extensions : []).slice(0, 40).map(x => ({
            key: truncate(String(x?.key || ''), 120),
            name: extensionName(x?.key),
            tokens: num(x?.tokens),
            preview: truncate(String(x?.preview || ''), 200),
        })),
        worldInfo: (Array.isArray(body?.worldInfo) ? body.worldInfo : []).slice(0, 60).map(x => ({
            world: truncate(String(x?.world || ''), 120),
            uid: num(x?.uid),
            label: truncate(String(x?.label || ''), 120),
            tokens: num(x?.tokens),
        })),
    };
}

/** Parts of the report as a list for the app, biggest first. */
export function reportItems(report) {
    if (!report) return [];
    const parts = { ...(report.parts || {}) };
    // With Chat Completion SillyTavern does not count the lorebook as one string; the fired entries do.
    const fired = (report.worldInfo || []).reduce((sum, x) => sum + (x.tokens || 0), 0);
    if (!parts.lorebook && fired) parts.lorebook = fired;
    return Object.entries(parts)
        .filter(([, tokens]) => tokens > 0)
        .map(([key, tokens]) => ({ key, label: PART_NAMES[key] ?? key, tokens }))
        .sort((a, b) => b.tokens - a.tokens);
}
