// Корректор: translation of messages that are already in the chat.
//
// SillyTavern's own "Translate whole chat" stops at the first error and only says
// "Failed to translate chat". Here every message is translated on its own:
//  - free translators tried in turn (Google → Bing → Yandex), each with retries and a pause;
//  - or Korrektor's cheap model (better with roleplay, costs a little);
//  - a range (last 20 / 50 / all), progress, a Stop button, and messages that failed
//    are listed and can be tried again.
// The translation goes to message.extra.display_text — the same place SillyTavern's
// translator uses: the original text stays, and "Show original" brings it back.

import { el, sheet, storage, store } from './gallery.js';

const ctx = () => SillyTavern.getContext();
const SETTINGS_KEY = 'korrektor.translate';
const MODEL_API = '/api/plugins/korrektor/translate';

export const LANGUAGES = [
    ['ru', 'Русский'], ['en', 'English'], ['uk', 'Українська'], ['be', 'Беларуская'], ['kk', 'Қазақша'],
    ['ja', '日本語'], ['ko', '한국어'], ['zh-CN', '中文'], ['de', 'Deutsch'], ['fr', 'Français'],
    ['es', 'Español'], ['it', 'Italiano'], ['pt-BR', 'Português'], ['pl', 'Polski'], ['tr', 'Türkçe'],
];

const FREE = ['google', 'bing', 'yandex'];
const LIMITS = { google: 4500, bing: 1000, yandex: 4000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settings() {
    const saved = storage(SETTINGS_KEY, {});
    const stLang = ctx().extensionSettings?.translate?.target_language;
    return {
        lang: saved.lang || (stLang && stLang !== 'en' ? stLang : 'ru'),
        engine: saved.engine || 'free',
        range: saved.range || 'last20',
        mine: saved.mine ?? true,
        again: false,
    };
}

// ---------- splitting ----------

/** Pieces that must not go to a translator: pictures, code, HTML tags, {{macros}}. */
const KEEP = /(!\[[^\]]*\]\([^)]*\)|```[\s\S]*?```|<[^>]+>|\{\{[^}]*\}\})/;
const KEEP_ALL = new RegExp(`^${KEEP.source}$`);

/** Cuts a long text at paragraph, then sentence, then word boundaries. */
export function chunkText(text, size) {
    if (text.length <= size) return [text];
    const out = [];
    let rest = text;
    while (rest.length > size) {
        const window = rest.slice(0, size);
        let cut = window.lastIndexOf('\n');
        if (cut < size * 0.3) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? ')) + 1;
        if (cut < size * 0.3) cut = window.lastIndexOf(' ');
        if (cut < size * 0.3) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
}

// ---------- providers ----------

async function free(provider, text, lang) {
    const headers = ctx().getRequestHeaders();
    const body = provider === 'yandex' ? { chunks: [text], lang } : { text, lang };
    const res = await fetch(`/api/translate/${provider}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw Object.assign(new Error(`${provider}: ${res.status}`), { status: res.status });
    const out = await res.text();
    if (!out.trim() && text.trim()) throw new Error(`${provider}: пустой ответ`);
    return out;
}

async function viaModel(text, lang) {
    // X-Korrektor: the plugin may use this tab's session to reach the model.
    const headers = { ...ctx().getRequestHeaders(), 'X-Korrektor': '1' };
    const res = await fetch(MODEL_API, { method: 'POST', headers, body: JSON.stringify({ text, lang }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `модель: ${res.status}`), { fatal: res.status === 404 || res.status === 409 || res.status === 400 });
    return String(data.text ?? '');
}

/** One provider, one piece of text: `tries` attempts with growing pauses. */
async function withRetries(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn();
        } catch (error) {
            last = error;
            if (error.fatal || error.status === 400 || error.status === 403) break;
            if (i < tries - 1) await sleep(800 * (i + 1) * (i + 1));
        }
    }
    throw last;
}

/**
 * The translator for one run. Free providers are tried in turn; the one that worked
 * is used first for the rest of the run.
 */
function translator(engine, lang) {
    let order = [...FREE];
    // A provider that failed twice in a row is skipped for the rest of the run,
    // so a blocked translator costs seconds, not minutes.
    const strikes = new Map();
    const translatePiece = async (piece) => {
        if (!piece.trim()) return piece;
        // Keep the spaces and line breaks around the piece: translators drop them.
        const [, lead, core, tail] = piece.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (engine === 'model') return lead + await withRetries(() => viaModel(core, lang)) + tail;
        let last;
        const alive = order.filter((p) => (strikes.get(p) || 0) < 2);
        if (!alive.length) throw Object.assign(new Error('Бесплатные переводчики сейчас не отвечают (часто это временно или блокировка у провайдера). Попробуйте позже или «Модель Корректора»'), { fatal: true });
        for (const provider of alive) {
            try {
                const parts = chunkText(core, LIMITS[provider]);
                let out = '';
                for (const part of parts) out += await withRetries(() => free(provider, part, lang), 2);
                strikes.set(provider, 0);
                if (order[0] !== provider) order = [provider, ...order.filter((p) => p !== provider)];
                return lead + out + tail;
            } catch (error) {
                last = error;
                strikes.set(provider, (strikes.get(provider) || 0) + 1);
            }
        }
        throw last;
    };
    return async (text) => {
        let out = '';
        // split() with a group keeps the kept pieces in the list.
        for (const piece of text.split(KEEP)) {
            if (piece === undefined) continue;
            out += KEEP_ALL.test(piece) ? piece : await translatePiece(piece);
        }
        return out;
    };
}

// ---------- the run ----------

let running = null;

function pickMessages(chat, { range, mine, again }) {
    const ids = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || !String(m.mes || '').trim()) continue;
        if (m.is_user && !mine) continue;
        if (!again && m.extra?.display_text) continue;
        ids.push(i);
    }
    const last = { last20: 20, last50: 50 }[range];
    if (last) {
        const from = Math.max(0, chat.length - last);
        return ids.filter((i) => i >= from);
    }
    return ids;
}

function prepare(message) {
    const c = ctx();
    return String(message.mes)
        .replace(/\{\{user\}\}/gi, c.name1 || '{{user}}')
        .replace(/\{\{char\}\}/gi, message.is_user ? (c.name2 || '{{char}}') : (message.name || c.name2 || '{{char}}'));
}

function busy() {
    const p = ctx().streamingProcessor;
    return Boolean(p && !p.isFinished);
}

/**
 * Translates messages of the open chat. `onProgress({ done, total, failed })` is called
 * after each one. Returns { done, failed: [ids], stopped, error }.
 */
export async function translateChat(options, onProgress = () => { }) {
    if (running) throw new Error('Перевод уже идёт');
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    const chat = c.chat;
    if (!chatId || !chat?.length) throw new Error('Откройте чат');
    const ids = options.ids || pickMessages(chat, options);
    const translate = translator(options.engine, options.lang);
    const state = { done: 0, total: ids.length, failed: [], stopped: false, error: '' };
    running = state;
    let streak = 0;
    let lastError = null;
    try {
        for (const id of ids) {
            if (state.stopped) break;
            if (c.getCurrentChatId?.() !== chatId || ctx().chat !== chat) {
                state.stopped = true;
                state.error = 'Чат сменился — перевод остановлен';
                break;
            }
            const message = chat[id];
            if (!message || (busy() && id === chat.length - 1)) continue;
            try {
                const text = await translate(prepare(message));
                if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
                message.extra.display_text = text;
                ctx().updateMessageBlock(id, message);
                state.done++;
                streak = 0;
            } catch (error) {
                state.failed.push(id);
                lastError = error;
                streak++;
                // Three messages in a row failed with every translator: it is not one bad message.
                if (streak >= 3) {
                    state.error = options.engine === 'model'
                        ? `Модель не отвечает: ${error.message}`
                        : 'Бесплатные переводчики сейчас не отвечают (часто это временно или блокировка у провайдера). Попробуйте позже или «Модель Корректора»';
                    break;
                }
                if (error.fatal) {
                    state.error = error.message;
                    break;
                }
            }
            onProgress(state);
            if (state.done && state.done % 10 === 0) await ctx().saveChat();
            if (options.engine !== 'model') await sleep(250);
        }
        if (state.done) await ctx().saveChat();
        if (!state.error && state.failed.length && lastError) state.error = lastError.message;
        return state;
    } finally {
        running = null;
    }
}

export function stopTranslation() {
    if (running) running.stopped = true;
}

export async function showOriginal() {
    const c = ctx();
    let changed = 0;
    c.chat?.forEach((message, id) => {
        if (message?.extra?.display_text) {
            delete message.extra.display_text;
            c.updateMessageBlock(id, message);
            changed++;
        }
    });
    if (changed) await c.saveChat();
    return changed;
}

// ---------- the sheet ----------

function seg(options, value, onchange) {
    const box = el('div', { class: 'kg-seg' });
    const draw = (v) => box.replaceChildren(...options.map(([key, label]) =>
        el('button', { type: 'button', class: v === key ? 'on' : '', onclick: () => { draw(key); onchange(key); }, text: label })));
    draw(value);
    return box;
}

export function openTranslate(preset = {}) {
    const s = { ...settings(), ...preset };
    const save = () => store(SETTINGS_KEY, { lang: s.lang, engine: s.engine, range: s.range, mine: s.mine });
    const chat = ctx().chat || [];
    const translated = chat.filter((m) => m?.extra?.display_text).length;

    const lang = el('select', { class: 'text_pole', onchange: (e) => { s.lang = e.target.value; save(); } },
        LANGUAGES.map(([code, label]) => el('option', { value: code, selected: code === s.lang, text: label })));
    const status = el('div', { class: 'kg-progress' });
    const bar = el('div', { class: 'kg-bar' }, el('i'));
    bar.hidden = true;
    const startBtn = el('button', { type: 'button', class: 'menu_button kg-main', text: 'Перевести' });
    const stopBtn = el('button', { type: 'button', class: 'menu_button', text: 'Стоп', onclick: stopTranslation });
    stopBtn.hidden = true;
    const originalBtn = el('button', {
        type: 'button', class: 'menu_button', text: 'Показать оригинал', onclick: async () => {
            const n = await showOriginal();
            status.textContent = n ? `Оригинал возвращён в ${n} сообщ.` : 'Переведённых сообщений нет';
        },
    });
    let retryIds = null;
    const retryBtn = el('button', { type: 'button', class: 'menu_button', text: 'Повторить пропущенные' });
    retryBtn.hidden = true;

    const run = async (ids = null) => {
        startBtn.disabled = true;
        retryBtn.hidden = true;
        stopBtn.hidden = false;
        bar.hidden = false;
        const fill = bar.firstChild;
        fill.style.width = '0%';
        status.textContent = 'Начинаю…';
        try {
            const result = await translateChat({ ...s, ids }, (st) => {
                fill.style.width = `${st.total ? Math.round(((st.done + st.failed.length) / st.total) * 100) : 100}%`;
                status.textContent = `Переведено ${st.done} из ${st.total}${st.failed.length ? `, не вышло: ${st.failed.length}` : ''}`;
            });
            if (!result.total) status.textContent = s.again ? 'Нечего переводить' : 'Всё в этом диапазоне уже переведено. Включите «Заново», чтобы перевести ещё раз';
            else status.textContent = `${result.stopped && !result.error ? 'Остановлено. ' : ''}Переведено ${result.done} из ${result.total}.${result.failed.length ? ` Не вышло: ${result.failed.length}.` : ''}${result.error ? ` ${result.error}` : ''}`;
            retryIds = result.failed.length ? result.failed : null;
            retryBtn.hidden = !retryIds;
            if (result.done) toastr.success(`Переведено сообщений: ${result.done}`, 'Корректор');
        } catch (error) {
            status.textContent = error.message;
        } finally {
            startBtn.disabled = false;
            stopBtn.hidden = true;
        }
    };
    startBtn.addEventListener('click', () => run());
    retryBtn.addEventListener('click', () => run(retryIds));

    const mine = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.mine, onchange: (e) => { s.mine = e.target.checked; save(); } }), el('span', { text: 'И мои сообщения' }));
    const again = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.again, onchange: (e) => { s.again = e.target.checked; } }), el('span', { text: 'Заново (уже переведённые тоже)' }));

    const body = el('div', { class: 'kg-translate' },
        el('div', { class: 'kg-label', text: 'На какой язык' }), lang,
        el('div', { class: 'kg-label', text: 'Какие сообщения' }),
        seg([['last20', 'Последние 20'], ['last50', 'Последние 50'], ['all', 'Весь чат']], s.range, (v) => { s.range = v; save(); }),
        el('div', { class: 'kg-label', text: 'Чем переводить' }),
        seg([['free', 'Бесплатно (Google и др.)'], ['model', 'Модель Корректора']], s.engine, (v) => { s.engine = v; save(); }),
        el('div', { class: 'kg-checks' }, mine, again),
        el('div', { class: 'kg-actions' }, startBtn, stopBtn, retryBtn),
        bar, status,
        el('div', { class: 'kg-actions' }, originalBtn),
        el('p', { class: 'kg-hint', text: `Перевод только показывается: текст сообщений не меняется, модель видит оригинал. ${translated ? `Сейчас переведено: ${translated}. ` : ''}«Модель Корректора» — дешёвая модель из настроек Корректора: лучше держит ролевой стиль, но тратит немного денег.` }));
    sheet('Перевод чата', body);
}

// ---------- entry points ----------

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('korrektor_translate_menu')) return Boolean(menu);
    menu.append(el('div', { id: 'korrektor_translate_menu', class: 'list-group-item flex-container flexGap5', onclick: () => openTranslate() },
        el('div', { class: 'fa-solid fa-language extensionsMenuExtensionButton' }), el('span', { text: 'Перевести чат' })));
    return true;
}

export function initTranslate() {
    window.korrektorTranslate = {
        open: openTranslate,
        chat: translateChat,
        stop: stopTranslation,
        original: showOriginal,
        running: () => Boolean(running),
    };
    const timer = setInterval(() => { if (addMenuItem()) clearInterval(timer); }, 1000);
}
