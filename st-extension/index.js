// Companion for the Korrektor server plugin.
// Also adds quick backgrounds and the avatar window (gallery.js).
import { initGallery } from './gallery.js';
import { initTranslate } from './translate.js';

// When Korrektor changes the open chat, a lorebook, a card or the settings,
// this tab reloads them, so its next save does not overwrite the fix.

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
    let reloadPage = false;
    const later = [];

    for (const item of items) {
        if (item.type === 'chat' && item.ref === chatId) {
            if (busy(ctx)) later.push(item);
            else reloadChat = true;
        } else if (item.type === 'world') {
            const module = await worldInfoModule();
            if (module) {
                module.worldInfoCache?.delete?.(item.ref);
                // A lorebook added or removed by Korrektor (catalog): the list in SillyTavern changes too.
                await module.updateWorldInfoList?.();
                module.reloadEditor?.(item.ref);
            }
        } else if (item.type === 'card') {
            await ctx.getCharacters?.();
        } else if (item.type === 'settings' || item.type === 'preset') {
            // SillyTavern keeps settings in the page and saves them back on its own,
            // so the page must reload, or it would overwrite the change.
            if (busy(ctx)) later.push(item);
            else reloadPage = true;
        }
    }
    waiting = later;

    if (reloadPage) {
        toastr.info('Корректор изменил настройки SillyTavern, страница обновится');
        setTimeout(() => location.reload(), 1500);
        return;
    }
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

// ---------- exact numbers of the last request ----------
// After each reply SillyTavern itemizes the prompt it sent and counts tokens
// with the model's tokenizer. Send that, the injections made by extensions and
// the lorebook entries that fired, so the app can show real numbers.

const REPORT_API = '/api/plugins/korrektor/actual';
let lastWorldInfo = [];
let itemized = null;

async function itemizedModule() {
    if (itemized !== null) return itemized;
    try {
        itemized = await import('../../../itemized-prompts.js');
    } catch {
        itemized = false;
    }
    return itemized;
}

async function count(ctx, text) {
    if (!text) return 0;
    try {
        return await ctx.getTokenCountAsync(String(text));
    } catch {
        return Math.ceil(String(text).length / 3);
    }
}

async function report() {
    const ctx = SillyTavern.getContext();
    const chatId = currentChatId(ctx);
    if (!chatId || !ctx.chat?.length) return;
    const mesId = ctx.chat.length - 1;
    const body = { chatId, mesId, at: new Date().toISOString(), parts: {}, extensions: [], worldInfo: [] };
    // The reply's length: with the prompt size it makes the cost of this request.
    body.replyTokens = await count(ctx, ctx.chat[mesId]?.mes);

    const module = await itemizedModule();
    if (module?.itemizedPrompts && module.findItemizedPromptSet && module.itemizedParams) {
        try {
            const set = module.findItemizedPromptSet(module.itemizedPrompts, mesId);
            if (set !== undefined) {
                const p = await module.itemizedParams(module.itemizedPrompts, set, mesId);
                const isChat = p.this_main_api === 'openai';
                body.api = p.this_main_api;
                body.model = p.modelUsed || '';
                body.preset = p.presetName || '';
                body.tokenizer = p.selectedTokenizer || '';
                body.total = Number(isChat ? p.finalPromptTokens : p.totalTokensInPrompt) || 0;
                body.maxContext = Number(p.thisPrompt_max_context) || 0;
                body.parts = {
                    system: Number(isChat ? p.oaiSystemTokens : p.instructionTokens) || 0,
                    card: (Number(p.charDescriptionTokens) || 0) + (Number(p.charPersonalityTokens) || 0) + (Number(p.scenarioTextTokens) || 0),
                    persona: Number(p.userPersonaStringTokens) || 0,
                    examples: Number(p.examplesStringTokens) || 0,
                    lorebook: Number(p.worldInfoStringTokens) || 0,
                    history: Number(p.ActualChatHistoryTokens) || 0,
                    summary: Number(p.summarizeStringTokens) || 0,
                    authorsNote: Number(p.authorsNoteStringTokens) || 0,
                    chatVectors: Number(p.chatVectorsStringTokens) || 0,
                    dataBank: Number(p.dataBankVectorsStringTokens) || 0,
                    injections: Number(p.chatInjects) || 0,
                };
            }
        } catch (error) {
            console.debug('[korrektor] itemized prompt not available', error);
        }
    }

    // Every injection made by extensions (Summarize, Data Bank, vectors, CharMemory and others).
    for (const [key, value] of Object.entries(ctx.extensionPrompts || {})) {
        const text = value?.value;
        if (!text || !String(text).trim()) continue;
        body.extensions.push({ key, tokens: await count(ctx, text), position: value.position, depth: value.depth, preview: String(text).slice(0, 160) });
    }
    for (const entry of lastWorldInfo.slice(0, 60)) {
        body.worldInfo.push({ world: entry.world, uid: entry.uid, label: entry.comment || (entry.key || []).slice(0, 3).join(', '), tokens: await count(ctx, entry.content) });
    }
    lastWorldInfo = [];

    try {
        await fetch(REPORT_API, { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body) });
    } catch {
        // plugin not installed or server restarting
    }
}

try {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, (entries) => {
        lastWorldInfo = Array.isArray(entries) ? entries : [];
    });
    let timer = null;
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        // Once per finished reply; give SillyTavern a moment to store the itemized prompt.
        clearTimeout(timer);
        timer = setTimeout(() => { report().catch(() => { }); }, 800);
    });
} catch (error) {
    console.debug('[korrektor] events not available', error);
}

setInterval(poll, INTERVAL_MS);
poll();

try {
    initGallery();
} catch (error) {
    console.warn('[korrektor] gallery not available', error);
}

try {
    initTranslate();
} catch (error) {
    console.warn('[korrektor] translation not available', error);
}
