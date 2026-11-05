import { cardTokens, constantEntries, latestMemory, visibleMessages } from '../chat-context.mjs';
import { estimateTokens } from '../tokens.mjs';
import { fingerprint, makeProposal } from '../proposals.mjs';
import { messageText } from '../chats.mjs';

export const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

/** Rough picture of what goes into the prompt for this chat. */
export function contextUsage(cc) {
    const { chat } = cc;
    const cardPart = Math.max(0, ...cc.cards.map(c => cardTokens(c.card).total));
    const lorePart = constantEntries(cc.worlds).reduce((sum, { entry }) => sum + estimateTokens(entry.content), 0);
    const meta = chat.header?.chat_metadata || {};
    const notePart = estimateTokens(meta.note_prompt || '');
    const memory = latestMemory(chat);
    const memoryPart = estimateTokens(memory?.text || '');
    const visible = visibleMessages(chat);
    const chatPart = visible.reduce((sum, { message }) => sum + estimateTokens(messageText(message)) + 4, 0);
    const overhead = 200;
    const budget = Math.max(0, cc.conn.contextSize - cc.conn.responseSize);
    const total = cardPart + lorePart + notePart + memoryPart + chatPart + overhead;
    return {
        budget,
        total,
        ratio: budget ? total / budget : 0,
        parts: { card: cardPart, lorebook: lorePart, note: notePart, memory: memoryPart, chat: chatPart, overhead },
        visibleCount: visible.length,
        hiddenCount: chat.messages.length - visible.length,
        memory,
    };
}

export function analyzeContext(cc, settings) {
    const usage = contextUsage(cc);
    if (!usage.budget || usage.ratio < settings.thresholds.contextWarn) return [];

    const visible = visibleMessages(cc.chat);
    const keep = Math.max(10, settings.summary.keepRecent);
    const candidates = visible.slice(0, Math.max(0, visible.length - keep));
    if (candidates.length < 10) return [];

    // One summary request covers at most ~60k tokens; the next part gets its own card later.
    const range = [];
    let tokens = 0;
    for (const item of candidates) {
        const t = estimateTokens(messageText(item.message)) + 4;
        if (range.length && tokens + t > 60000) break;
        range.push(item.index);
        tokens += t;
    }

    const overflow = usage.ratio >= 1;
    const from = range[0];
    const to = range[range.length - 1];
    const percent = Math.round(usage.ratio * 100);
    return [makeProposal({
        kind: 'context',
        severity: overflow ? 'high' : 'medium',
        title: overflow ? 'Чат не помещается в контекст' : 'Контекст почти заполнен',
        summary: overflow
            ? `Модель уже не видит начало чата: занято ≈${fmt(usage.total)} из ${fmt(usage.budget)} токенов (${percent}%). Резюме старых сообщений сохранит важное и освободит место`
            : `Занято ≈${fmt(usage.total)} из ${fmt(usage.budget)} токенов (${percent}%). Скоро начало чата начнёт выпадать из памяти модели`,
        evidence: [
            { label: 'Сообщения чата', text: `≈${fmt(usage.parts.chat)} токенов, ${usage.visibleCount} сообщений в контексте` },
            { label: 'Карточка', text: `≈${fmt(usage.parts.card)} токенов` },
            { label: 'Постоянные записи лорбуков', text: `≈${fmt(usage.parts.lorebook)} токенов` },
            { label: 'Предлагается сжать', text: `сообщения #${from}–${to} (${range.length} шт., ≈${fmt(tokens)} токенов), последние ${keep} остаются как есть` },
        ],
        target: { type: 'chat', chatId: cc.chatId, label: cc.title },
        fingerprint: fingerprint('context', cc.chatId, from, Math.floor(usage.visibleCount / 50)),
        prepare: { type: 'summary', chatId: cc.chatId, indices: range },
    })];
}
