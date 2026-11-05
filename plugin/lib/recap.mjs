import { readChat } from './chats.mjs';
import { chatLanguageIsRussian, transcript, visibleMessages } from './chat-context.mjs';
import { httpError, nowIso } from './util.mjs';

// "Session recap": what happened in a chat since the last recap (or in its
// latest messages): a short retelling by the cheap model, plus what Korrektor
// found there meanwhile. Nothing in the chat is changed.

const FIRST_TIME = 30;
const MAX_MESSAGES = 60;

export function recapRange(chat, previous) {
    const visible = visibleMessages(chat).map(v => v.index);
    if (!visible.length) return null;
    const last = visible.at(-1);
    const after = Number.isInteger(previous?.to) ? previous.to : -1;
    let picked = visible.filter(i => i > after);
    if (!picked.length) return { from: last, to: last, indices: [], nothingNew: true };
    if (after < 0) picked = picked.slice(-FIRST_TIME);
    picked = picked.slice(-MAX_MESSAGES);
    return { from: picked[0], to: last, indices: picked, nothingNew: false };
}

export function foundSince(proposals, chatId, sinceIso) {
    const counts = {};
    for (const p of proposals) {
        const related = p.target?.chatId === chatId || (p.chats || []).includes(chatId);
        if (!related || (sinceIso && p.createdAt <= sinceIso)) continue;
        counts[p.kind] = (counts[p.kind] || 0) + 1;
    }
    return counts;
}

export async function makeRecap(ctx, store, { chatId, llm }) {
    const chat = await readChat(ctx, chatId);
    const state = await store.getState();
    const previous = state.chats?.[chatId]?.recap ?? null;
    const range = recapRange(chat, previous);
    if (!range) throw httpError(400, 'В этом чате ещё нет сообщений');
    const found = foundSince(await store.getProposals(), chatId, previous?.at ?? null);
    if (range.nothingNew) return { ...previous, nothingNew: true, found };

    const ru = chatLanguageIsRussian(chat);
    const system = [
        'Ты помогаешь игроку ролевого чата вспомнить, что произошло.',
        'Перескажи события из присланных сообщений: 3–6 коротких пунктов, каждый с новой строки и с «• » в начале.',
        'Только события сюжета, решения и перемены в отношениях; без оценок и без пересказа стиля.',
        'Последним пунктом — на чём остановились.',
        ru ? 'Пиши по-русски.' : 'Пиши по-русски, даже если чат на другом языке; имена оставляй как в чате.',
    ].join(' ');
    const reply = await llm.complete({
        task: 'recap',
        system,
        user: `Сообщения чата:\n\n${transcript(chat, range.indices, { maxCharsPerMessage: 1500 })}`,
    });
    const recap = {
        at: nowIso(),
        from: range.from,
        to: range.to,
        messages: range.indices.length,
        text: reply.text.trim(),
        model: reply.model,
    };
    await store.updateState(s => {
        s.chats = s.chats || {};
        s.chats[chatId] = { ...(s.chats[chatId] || {}), recap };
    });
    return { ...recap, found };
}
