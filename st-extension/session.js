// Корректор: if the tavern page reloads (Android unloaded it while other apps were open,
// the browser froze the tab), the same chat opens again, at the same place, with the
// message that was being typed. Kept in this browser only (localStorage).

const ctx = () => SillyTavern.getContext();
const KEY = 'korrektor.session';
const FRESH_MS = 12 * 60 * 60 * 1000;

function read() {
    try {
        return JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
        return null;
    }
}

function write(value) {
    try {
        localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
        // private mode: nothing is remembered
    }
}

/** The first message at the top of the visible part of the chat. */
function topMessageId() {
    const chat = document.getElementById('chat');
    if (!chat) return null;
    const top = chat.getBoundingClientRect().top;
    for (const mes of chat.querySelectorAll('.mes[mesid]')) {
        if (mes.getBoundingClientRect().bottom > top + 8) return Number(mes.getAttribute('mesid'));
    }
    return null;
}

/** Scrolled to the very end: then after a reload the end is shown again, as SillyTavern does itself. */
function atBottom() {
    const chat = document.getElementById('chat');
    return !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
}

let restoring = false;

function save() {
    if (restoring) return;
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    if (!chatId) return;
    const character = c.characters?.[c.characterId];
    write({
        at: Date.now(),
        chatId,
        groupId: c.groupId || null,
        avatar: c.groupId ? null : character?.avatar || null,
        mesId: atBottom() ? null : topMessageId(),
        draft: document.getElementById('send_textarea')?.value || '',
    });
}

let timer = null;
function saveSoon() {
    clearTimeout(timer);
    timer = setTimeout(save, 700);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function restore() {
    const saved = read();
    if (!saved || Date.now() - saved.at > FRESH_MS || !saved.chatId) return;
    restoring = true;
    try {
        let c = ctx();
        // Nothing open yet (a fresh page): open the chat that was open before.
        if (!c.getCurrentChatId?.()) {
            if (saved.groupId && c.openGroupChat) {
                await c.openGroupChat(saved.groupId, saved.chatId);
            } else if (saved.avatar) {
                const index = c.characters.findIndex((ch) => ch.avatar === saved.avatar);
                if (index < 0) return;
                await c.selectCharacterById(String(index));
                await wait(300);
                c = ctx();
                if (c.getCurrentChatId?.() !== saved.chatId) await c.openCharacterChat(saved.chatId);
            }
            await wait(400);
        }
        c = ctx();
        // Another chat is open (chosen by the person or by the app): leave it.
        if (c.getCurrentChatId?.() !== saved.chatId) return;
        const box = document.getElementById('send_textarea');
        if (box && !box.value && saved.draft) {
            box.value = saved.draft;
            box.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (saved.mesId !== null && saved.mesId !== undefined) {
            const mes = document.querySelector(`#chat .mes[mesid="${saved.mesId}"]`);
            if (mes) mes.scrollIntoView({ block: 'start' });
        }
    } catch (error) {
        console.debug('[korrektor] could not reopen the chat', error);
    } finally {
        restoring = false;
    }
}

export function initSession() {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
    window.addEventListener('pagehide', save);
    document.addEventListener('input', (e) => { if (e.target?.id === 'send_textarea') saveSoon(); });
    // The chat scrolls inside #chat; the listener goes on once it exists.
    const hookScroll = setInterval(() => {
        const chat = document.getElementById('chat');
        if (!chat) return;
        chat.addEventListener('scroll', saveSoon, { passive: true });
        clearInterval(hookScroll);
    }, 1000);
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, saveSoon);
    let started = false;
    const start = () => {
        if (started) return;
        started = true;
        setTimeout(() => { restore().catch(() => { }); }, 500);
    };
    if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, start);
    // Without that event (or if it already passed): once characters are loaded, a little later.
    const poll = setInterval(() => {
        const waited = Date.now() - loadedAt;
        if ((ctx().characters?.length && waited > (eventTypes.APP_READY ? 15000 : 3000)) || waited > 30000) {
            clearInterval(poll);
            start();
        }
    }, 1000);
}

const loadedAt = Date.now();
