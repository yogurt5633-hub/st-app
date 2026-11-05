import { visibleMessages } from '../chat-context.mjs';
import { promptBudget } from '../prompt-budget.mjs';
import { estimateTokens } from '../tokens.mjs';
import { fingerprint, makeProposal } from '../proposals.mjs';
import { messageText } from '../chats.mjs';

export const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

/** What goes into the prompt for this chat (see prompt-budget.mjs). */
export function contextUsage(cc) {
    return promptBudget(cc, cc.stSettings);
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
            ...usage.items.slice(0, 4).map(item => ({ label: item.label, text: `≈${fmt(item.tokens)} токенов` })),
            { label: 'Предлагается сжать', text: `сообщения #${from}–${to} (${range.length} шт., ≈${fmt(tokens)} токенов), последние ${keep} остаются как есть` },
        ],
        target: { type: 'chat', chatId: cc.chatId, label: cc.title },
        fingerprint: fingerprint('context', cc.chatId, from, Math.floor(usage.visibleCount / 50)),
        prepare: { type: 'summary', chatId: cc.chatId, indices: range },
    })];
}
