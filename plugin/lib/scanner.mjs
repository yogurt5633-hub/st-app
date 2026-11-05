import { listChats } from './chats.mjs';
import { buildChatContext, visibleMessages } from './chat-context.mjs';
import { readStSettings } from './st-settings.mjs';
import { addProposals, markResolved } from './proposals.mjs';
import { analyzeContext } from './analyzers/context.mjs';
import { analyzeRepetition, analyzeSlop } from './analyzers/repetition.mjs';
import { analyzeDuplicates, analyzeKeys, analyzeLoreBloat } from './analyzers/lorebook.mjs';
import { analyzeCardBloat } from './analyzers/bloat.mjs';
import { analyzeContradictions, analyzeFacts } from './analyzers/llm.mjs';
import { nowIso } from './util.mjs';

const RECENT_DAYS = 14;

async function pickChats(ctx, settings, state, { chatIds, background }) {
    if (Array.isArray(chatIds) && chatIds.length) return chatIds.map(id => ({ id, mtime: null }));
    const all = await listChats(ctx);
    const fresh = all.filter(c => Date.now() - c.mtime < RECENT_DAYS * 864e5).slice(0, settings.scan.recentChats);
    if (!background) return fresh;
    // In the background only chats that changed since the last scan.
    return fresh.filter(c => (state.chats?.[c.id]?.scannedMtime ?? 0) < c.mtime);
}

/**
 * One scan pass. Heuristic checks always run; model checks run when a model
 * client is available and enabled in settings.
 */
export async function runScan(ctx, store, { chatIds = null, llm = null, background = false, log = () => { } } = {}) {
    const settings = await store.getSettings();
    const stSettings = await readStSettings(ctx);
    const state = await store.getState();
    const a = settings.analyzers;
    const chats = await pickChats(ctx, settings, state, { chatIds, background });
    const useModel = Boolean(llm?.available && settings.scan.useModel && (a.facts || a.contradictions));

    const found = [];
    const errors = [];
    const chatUpdates = {};
    const seenCards = new Set();
    const seenWorlds = new Set();

    const guard = async (label, fn) => {
        try {
            return await fn();
        } catch (error) {
            errors.push(`${label}: ${error.message}`);
            log(`Ошибка: ${label}: ${error.message}`);
            return null;
        }
    };

    if (!chats.length) log('Новых изменений в чатах нет');

    for (const item of chats) {
        const cc = await guard(`чат ${item.id}`, () => buildChatContext(ctx, item.id, stSettings));
        if (!cc) continue;
        log(`Чат «${cc.title}»: ${cc.chat.messages.length} сообщений`);

        const chatFound = [];
        if (a.context) chatFound.push(...(await guard('контекст', () => analyzeContext(cc, settings)) ?? []));
        if (a.repetition) chatFound.push(...(await guard('повторы', () => analyzeRepetition(cc, settings)) ?? []));
        if (a.slop) chatFound.push(...(await guard('штампы', () => analyzeSlop(cc, settings)) ?? []));
        await markResolved(store, `chat:${cc.chatId}`, new Set(chatFound.map(p => p.fingerprint)), ['context', 'repetition', 'slop']);
        found.push(...chatFound);

        for (const entry of cc.cards) {
            if (seenCards.has(entry.avatar) || !a.bloat) continue;
            seenCards.add(entry.avatar);
            const list = await guard('карточка', () => analyzeCardBloat(entry, settings, cc.conn.contextSize)) ?? [];
            await markResolved(store, `card:${entry.avatar}`, new Set(list.map(p => p.fingerprint)), ['card_bloat']);
            found.push(...list);
        }

        for (const world of cc.worlds) {
            if (seenWorlds.has(world.name)) continue;
            seenWorlds.add(world.name);
            const list = [];
            if (a.loreDuplicates) list.push(...(await guard('дубли лорбука', () => analyzeDuplicates(world)) ?? []));
            if (a.loreKeys) list.push(...(await guard('ключи лорбука', () => analyzeKeys(world)) ?? []));
            if (a.bloat) list.push(...(await guard('объём лорбука', () => analyzeLoreBloat(world, settings)) ?? []));
            await markResolved(store, `world:${world.name}`, new Set(list.map(p => p.fingerprint)), ['lore_duplicate', 'lore_keys', 'lore_bloat']);
            found.push(...list);
        }

        const chatState = { ...(state.chats?.[cc.chatId] ?? {}) };
        if (useModel) {
            const since = Number.isInteger(chatState.llmIndex) ? chatState.llmIndex : -1;
            const lastVisible = visibleMessages(cc.chat).at(-1)?.index ?? -1;
            const newCount = visibleMessages(cc.chat).filter(v => v.index > since).length;
            // In the background wait for a few new messages so the cheap model is not called on every reply.
            if (newCount >= (background ? 4 : 1)) {
                let reached = since;
                if (a.facts) {
                    log('Ищу новые факты для лорбука');
                    const r = await guard('факты', () => analyzeFacts(cc, settings, llm, since));
                    if (r) {
                        found.push(...r.proposals);
                        reached = Math.max(reached, r.lastIndex);
                    }
                }
                if (a.contradictions) {
                    log('Ищу противоречия');
                    const r = await guard('противоречия', () => analyzeContradictions(cc, settings, llm, since));
                    if (r) {
                        found.push(...r.proposals);
                        reached = Math.max(reached, r.lastIndex);
                    }
                }
                chatState.llmIndex = Math.min(reached, lastVisible);
            }
        }
        chatState.scannedAt = nowIso();
        chatState.scannedMtime = item.mtime ?? Date.now();
        chatUpdates[cc.chatId] = chatState;
    }

    const added = await addProposals(store, found);
    const summary = {
        at: nowIso(),
        background,
        chats: chats.length,
        found: found.length,
        added: added.length,
        modelCalls: llm?.calls ?? 0,
        modelUsed: useModel,
        errors,
    };
    await store.updateState(s => {
        s.chats = { ...(s.chats || {}), ...chatUpdates };
        s.lastScan = summary;
    });
    log(added.length ? `Новых карточек: ${added.length}` : 'Новых проблем не найдено');
    return { ...summary, addedIds: added.map(p => p.id) };
}
