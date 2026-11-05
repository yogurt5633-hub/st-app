// Companion for the Korrektor server plugin.
// When Korrektor changes the open chat, a lorebook or a card, this tab reloads
// them, so its next save does not overwrite the fix.

const API = '/api/plugins/korrektor/touched';
const INTERVAL_MS = 4000;

let since = 0;
let waiting = [];
let wi = null;

async function worldInfoModule() {
    if (wi !== null) return wi;
    try {
        wi = await import('../../../world-info.js');
    } catch {
        wi = false;
    }
    return wi;
}

function currentChatId(ctx) {
    if (ctx.groupId) return ctx.chatId ? `g/${ctx.chatId}` : null;
    const character = ctx.characters?.[ctx.characterId];
    if (!character || !ctx.chatId) return null;
    return `c/${String(character.avatar).replace(/\.png$/i, '')}/${ctx.chatId}`;
}

function busy(ctx) {
    return Boolean(ctx.streamingProcessor && !ctx.streamingProcessor.isFinished);
}

async function handle(items) {
    const ctx = SillyTavern.getContext();
    const chatId = currentChatId(ctx);
    let reloadChat = false;
    const later = [];

    for (const item of items) {
        if (item.type === 'chat' && item.ref === chatId) {
            if (busy(ctx)) later.push(item);
            else reloadChat = true;
        } else if (item.type === 'world') {
            const module = await worldInfoModule();
            if (module) {
                module.worldInfoCache?.delete?.(item.ref);
                module.reloadEditor?.(item.ref);
            }
        } else if (item.type === 'card') {
            await ctx.getCharacters?.();
        }
    }
    waiting = later;

    if (reloadChat) {
        await ctx.reloadCurrentChat();
        toastr.info('Корректор изменил этот чат, он обновлён');
    }
}

async function poll() {
    if (document.visibilityState !== 'visible') return;
    try {
        const ctx = SillyTavern.getContext();
        const res = await fetch(`${API}?since=${since}`, { headers: ctx.getRequestHeaders(), cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        since = data.now;
        const items = [...waiting, ...(data.items || [])];
        if (items.length) await handle(items);
    } catch {
        // Plugin not installed or server restarting: try again later.
    }
}

setInterval(poll, INTERVAL_MS);
poll();
