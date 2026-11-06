// Корректор: translation of messages in the chat.
//
// SillyTavern's own "Translate whole chat" stops at the first error and only says
// "Failed to translate chat", and long replies sometimes come back half in English.
// Here every message is translated on its own:
//  - a chosen translator (Google, Bing, Yandex, DeepL, Lingva) or «Авто», which tries
//    them in turn; or Korrektor's cheap model (better with roleplay, costs a little);
//  - long text goes in small pieces, and a piece that comes back untranslated is
//    split further or given to the next translator;
//  - a range (last 20 / 50 / all), progress, a Stop button, failed messages can be retried;
//  - optionally every new reply is translated as it arrives.
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

export const ENGINES = [
    ['auto', 'Авто: Google, потом Bing, Яндекс, Lingva'],
    ['google', 'Google'],
    ['bing', 'Bing'],
    ['yandex', 'Яндекс'],
    ['deepl', 'DeepL (нужен ключ в таверне)'],
    ['lingva', 'Lingva'],
    ['model', 'Модель Корректора (лучше для ролёвки, платно)'],
];
const AUTO = ['google', 'bing', 'yandex', 'lingva'];
// Characters per request. Free translators drop the end of long text, so pieces stay small.
const LIMITS = { google: 1800, bing: 1000, yandex: 1500, lingva: 900, deepl: 4000, model: 3000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function settings() {
    const saved = storage(SETTINGS_KEY, {});
    const stLang = ctx().extensionSettings?.translate?.target_language;
    const engine = saved.engine === 'free' ? 'auto' : saved.engine;
    return {
        lang: saved.lang || (stLang && stLang !== 'en' ? stLang : 'ru'),
        engine: ENGINES.some(([k]) => k === engine) ? engine : 'auto',
        range: saved.range || 'last20',
        mine: saved.mine ?? true,
        auto: Boolean(saved.auto),
        again: false,
    };
}

function saveSettings(s) {
    store(SETTINGS_KEY, { lang: s.lang, engine: s.engine, range: s.range, mine: s.mine, auto: s.auto });
}

// ---------- splitting ----------

/** Pieces that must not go to a translator: pictures, code fences, HTML tags, {{macros}}. The text inside code blocks is translated. */
const KEEP = /(!\[[^\]]*\]\([^)]*\)|```[^\n`]*\n?|\n?```|<[^>]+>|\{\{[^}]*\}\})/;
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

const CYRILLIC_TARGETS = new Set(['ru', 'uk', 'be', 'kk']);

/** Share of Latin letters among all letters. */
function latinShare(text) {
    const letters = String(text).match(/\p{L}/gu) || [];
    if (!letters.length) return 0;
    return letters.filter((c) => /[A-Za-z]/.test(c)).length / letters.length;
}

/**
 * Came back (partly) untranslated: the same text, or still mostly English when the
 * target uses Cyrillic. Names and terms in Latin are fine, whole sentences are not.
 */
export function looksUntranslated(source, out, lang) {
    if (lang === 'en' || latinShare(source) < 0.6) return false;
    // Only ordinary words count (lower-case, 3+ letters): names, places, dates and terms
    // in Latin letters are fine in a translation — «Room 314, Calloway Hall» stays as is.
    const words = String(source).match(/(?<![\p{L}])[a-z][a-z']{2,}(?![\p{L}])/gu) || [];
    if (!words.length) return false;
    const src = String(source).replace(/\s+/g, ' ').trim();
    const res = String(out).replace(/\s+/g, ' ').trim();
    if (src === res) return words.length >= 2;
    if (words.length < 4) return false;
    const left = new Set((res.match(/(?<![\p{L}])[a-z][a-z']{2,}(?![\p{L}])/gu) || []));
    const kept = words.filter(w => left.has(w)).length;
    // Half or more of the ordinary words came back as they were: (part of) the text is not translated.
    return kept / words.length > 0.4;
}

// ---------- markup the translators break ----------

/** Pairs runs of asterisks in a line like markdown does and removes the spaces translators put inside. */
function tightenEmphasis(line) {
    const runs = [...line.matchAll(/\*{1,3}/g)].map(m => ({ at: m.index, len: m[0].length }));
    const pairs = [];
    const open = {};
    for (const run of runs) {
        if (open[run.len]) {
            pairs.push([open[run.len], run]);
            open[run.len] = null;
        } else {
            open[run.len] = run;
        }
    }
    let out = line;
    // From the end, so earlier positions stay valid.
    for (const [a, b] of pairs.reverse()) {
        const inner = out.slice(a.at + a.len, b.at);
        const trimmed = inner.trim();
        if (!trimmed || trimmed === inner) continue;
        out = out.slice(0, a.at + a.len) + trimmed + out.slice(b.at);
        const lead = inner.length - inner.trimStart().length;
        // Keep a word after the closing asterisks apart from it.
        const shift = inner.length - trimmed.length;
        if (out[b.at - shift + b.len] && /[\p{L}\d]/u.test(out[b.at - shift + b.len])) out = `${out.slice(0, b.at - shift + b.len)} ${out.slice(b.at - shift + b.len)}`;
        if (lead && a.at > 0 && /[\p{L}\d]/u.test(out[a.at - 1])) out = `${out.slice(0, a.at)} ${out.slice(a.at)}`;
    }
    return out;
}

/**
 * Translators turn «"Speech," he said» into «- Речь, — сказал он» and «*smiles*» into «* улыбается *».
 * SillyTavern shows such lines as a bulleted list with a dot in front. When the original has
 * no list here, the dash becomes «—» and asterisks hug the text again, as in the original.
 */
export function fixMarkup(source, out) {
    const sourceHasList = /^\s*(?:[-*+•]|\d+[.)])\s/m.test(source);
    return String(out).split('\n').map((line) => {
        let fixed = /\*/.test(source) ? tightenEmphasis(line) : line;
        if (!sourceHasList) {
            fixed = fixed.replace(/^(\s*)[-–‐•]\s+/, '$1— ');
            // A lone «* » left at the start of a line still makes a list item.
            fixed = fixed.replace(/^(\s*)\*\s+(?=[^*]*$)/, '$1');
        }
        return fixed;
    }).join('\n');
}

// ---------- providers ----------

async function free(provider, text, lang) {
    const headers = ctx().getRequestHeaders();
    const body = provider === 'yandex' ? { chunks: [text], lang }
        : provider === 'deepl' ? { text, lang, endpoint: ctx().extensionSettings?.translate?.deepl_endpoint || 'free' }
            : { text, lang };
    const res = await fetch(`/api/translate/${provider}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
        if (provider === 'deepl' && res.status === 400) {
            throw Object.assign(new Error('Для DeepL нужен ключ: Расширения → Chat Translation → DeepL → значок ключа'), { fatal: true });
        }
        throw Object.assign(new Error(`${provider}: ${res.status}`), { status: res.status });
    }
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
    const out = String(data.text ?? '');
    if (!out.trim() && text.trim()) throw new Error('модель: пустой ответ');
    return out;
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
 * Translates a piece with one provider. A part that comes back untranslated is split
 * in half and tried again (twice at most); if it still is, the provider has failed.
 */
/** Some translators answer with &quot; &lt; &#39; …: back to plain characters (unless the original had them). */
function decodeEntities(source, out) {
    if (/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(source)) return out;
    return String(out)
        .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
}

// ---------- what to send at all ----------

const SCRIPTS = {
    cyrillic: { langs: new Set(['ru', 'uk', 'be', 'kk']), test: /\p{Script=Cyrillic}/u },
    cjk: { langs: new Set(['ja', 'ko', 'zh-CN', 'zh-TW']), test: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u },
};

/** The line is already written in the target language's script: it is left exactly as it is. */
export function alreadyTarget(line, lang) {
    const script = Object.values(SCRIPTS).find(sc => sc.langs.has(lang));
    if (!script) return false;
    const letters = String(line).match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    return letters.filter(c => script.test.test(c)).length / letters.length >= 0.5;
}

/** Only lines with letters in another language go to a translator: borders, numbers, emoji and lines already translated stay. */
export function needsTranslation(line, lang) {
    if (alreadyTarget(line, lang)) return false;
    // At least one real word: abbreviations like HP, MP, STR, XP and single letters stay.
    return (String(line).match(/\p{L}+/gu) || []).some(w => w.length >= 2 && /\p{Ll}/u.test(w));
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

async function byProvider(provider, text, lang, limit = LIMITS[provider], depth = 0) {
    const call = provider === 'model' ? (part) => viaModel(part, lang) : (part) => free(provider, part, lang);
    let out = '';
    for (const part of chunkText(text, limit)) {
        if (!part.trim()) {
            out += part;
            continue;
        }
        const [, lead, core, tail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
        let result = fixMarkup(core, decodeEntities(core, await withRetries(() => call(core), 2)));
        if (looksUntranslated(core, result, lang)) {
            if (depth < 2 && core.length > 200) result = await byProvider(provider, core, lang, Math.ceil(core.length / 2), depth + 1);
            else throw Object.assign(new Error(`${provider}: вернул текст без перевода`), { untranslated: true });
        }
        out += lead + result + tail;
    }
    return out;
}

/**
 * The translator for one run. With «Авто» free providers are tried in turn and the one
 * that worked goes first for the rest of the run; a chosen provider is used alone.
 */
export function translator(engine, lang) {
    let order = engine === 'auto' || engine === 'free' ? [...AUTO] : [engine];
    // A provider that failed twice in a row is skipped for the rest of the run,
    // so a blocked translator costs seconds, not minutes.
    const strikes = new Map();
    const translateRun = async (piece) => {
        if (!piece.trim()) return piece;
        const alive = order.filter((p) => (strikes.get(p) || 0) < 2);
        if (!alive.length) {
            throw Object.assign(new Error(engine === 'auto' || order.length > 1
                ? 'Бесплатные переводчики сейчас не отвечают (часто это временно или блокировка у провайдера). Выберите другой переводчик или «Модель Корректора»'
                : `${ENGINES.find(([k]) => k === engine)?.[1] || engine} сейчас не переводит. Выберите другой переводчик`), { fatal: true });
        }
        let last;
        for (const provider of alive) {
            try {
                const out = await byProvider(provider, piece, lang);
                strikes.set(provider, 0);
                if (order[0] !== provider) order = [provider, ...order.filter((p) => p !== provider)];
                return out;
            } catch (error) {
                if (error.fatal) throw error;
                last = error;
                strikes.set(provider, (strikes.get(provider) || 0) + 1);
            }
        }
        throw last;
    };
    // Line by line: lines in the target language, lines without letters (borders, numbers) and
    // table borders stay exactly as they are, so status blocks and tables keep their shape.
    // Neighbouring lines that need translating go together, for context.
    let partial = 0;
    const translatePiece = async (piece) => {
        if (!piece.trim()) return piece;
        const out = [];
        let group = [];
        const flush = async () => {
            if (!group.length) return;
            // Blank lines at the end of a group stay outside it.
            let tail = 0;
            while (tail < group.length && !group[group.length - 1 - tail].trim()) tail++;
            const body = group.slice(0, group.length - tail);
            const blanks = group.slice(group.length - tail);
            group = [];
            if (body.length) {
                const source = body.join('\n');
                try {
                    out.push(await translateRun(source));
                } catch (error) {
                    // One stubborn piece does not cost the whole reply: it stays in the original.
                    if (!error.untranslated) throw error;
                    out.push(source);
                    partial++;
                }
            }
            out.push(...blanks);
        };
        for (const line of piece.split('\n')) {
            if (!line.trim() && group.length) {
                // Paragraphs of one reply go together: fewer requests, more context.
                group.push(line);
            } else if (!needsTranslation(line, lang)) {
                await flush();
                out.push(line);
            } else if (TABLE_ROW.test(line)) {
                // A table row: only the text of the cells, the | stay where they are.
                await flush();
                const cells = line.split('|');
                for (let i = 0; i < cells.length; i++) {
                    if (!needsTranslation(cells[i], lang)) continue;
                    const [, lead, core, tail] = cells[i].match(/^(\s*)([\s\S]*?)(\s*)$/);
                    cells[i] = lead + (await translateRun(core)).replace(/\|/g, '/').replace(/\n/g, ' ') + tail;
                }
                out.push(cells.join('|'));
            } else {
                group.push(line);
            }
        }
        await flush();
        return out.join('\n');
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
                const source = prepare(message);
                const text = await translate(source);
                if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
                // Already in this language: no translation over the original (an old bad one goes away).
                if (text === source) delete message.extra.display_text;
                else message.extra.display_text = text;
                ctx().updateMessageBlock(id, message);
                state.done++;
                streak = 0;
            } catch (error) {
                state.failed.push(id);
                lastError = error;
                streak++;
                // Three messages in a row failed with every translator: it is not one bad message.
                if (streak >= 3) {
                    state.error = options.engine === 'model' ? `Модель не отвечает: ${error.message}`
                        : error.untranslated ? 'Переводчик возвращает текст без перевода. Выберите другой переводчик или «Модель Корректора»'
                            : 'Переводчик сейчас не отвечает (часто это временно или блокировка у провайдера). Выберите другой или «Модель Корректора»';
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

// ---------- new replies ----------

/** SillyTavern's own auto-translation would translate the same reply again: leave it only for my messages. */
function quietStAuto() {
    const select = document.getElementById('translation_auto_mode');
    if (!select || !window.jQuery) return;
    const next = select.value === 'both' ? 'inputs' : select.value === 'responses' ? 'none' : null;
    if (next) window.jQuery(select).val(next).trigger('change');
}

const autoQueue = new Set();

/** Translates one new reply, if «Переводить новые ответы» is on. */
async function translateNew(messageId) {
    const s = settings();
    if (!s.auto) return;
    const id = Number(messageId);
    const c = ctx();
    const message = c.chat?.[id];
    if (!message || message.is_user || message.is_system || !String(message.mes || '').trim() || autoQueue.has(id)) return;
    autoQueue.add(id);
    const chatId = c.getCurrentChatId?.();
    try {
        const source = prepare(message);
        const text = await translator(s.engine, s.lang)(source);
        // The reply may have been edited, swiped or the chat changed meanwhile.
        if (ctx().getCurrentChatId?.() !== chatId || ctx().chat?.[id] !== message) return;
        if (text === source) return;
        if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
        message.extra.display_text = text;
        ctx().updateMessageBlock(id, message);
        await ctx().saveChat();
    } catch (error) {
        toastr.warning(`Не перевёл ответ: ${error.message}`, 'Корректор', { timeOut: 6000 });
    } finally {
        autoQueue.delete(id);
    }
}

export function setAuto(on, options = {}) {
    const s = { ...settings(), ...options, auto: Boolean(on) };
    saveSettings(s);
    if (s.auto) quietStAuto();
    return s;
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
    const save = () => saveSettings(s);
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
    const autoBox = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.auto, onchange: (e) => { s.auto = e.target.checked; save(); if (s.auto) quietStAuto(); } }),
        el('span', { text: 'Переводить новые ответы сразу (этим же переводчиком)' }));
    const again = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.again, onchange: (e) => { s.again = e.target.checked; } }), el('span', { text: 'Заново (уже переведённые тоже)' }));

    const body = el('div', { class: 'kg-translate' },
        el('div', { class: 'kg-label', text: 'На какой язык' }), lang,
        el('div', { class: 'kg-label', text: 'Какие сообщения' }),
        seg([['last20', 'Последние 20'], ['last50', 'Последние 50'], ['all', 'Весь чат']], s.range, (v) => { s.range = v; save(); }),
        el('div', { class: 'kg-label', text: 'Чем переводить' }),
        el('select', { class: 'text_pole', onchange: (e) => { s.engine = e.target.value; save(); } },
            ENGINES.map(([key, label]) => el('option', { value: key, selected: key === s.engine, text: label }))),
        el('div', { class: 'kg-checks' }, mine, again, autoBox),
        el('div', { class: 'kg-actions' }, startBtn, stopBtn, retryBtn),
        bar, status,
        el('div', { class: 'kg-actions' }, originalBtn),
        el('p', { class: 'kg-hint', text: `Перевод только показывается: текст сообщений не меняется, модель видит оригинал. ${translated ? `Сейчас переведено: ${translated}. ` : ''}«Модель Корректора» — дешёвая модель из настроек Корректора: лучше держит ролевой стиль, но тратит немного денег. Если переводчик возвращает кусок на английском, Корректор переводит его заново по частям или другим переводчиком.` }));
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
        settings,
        setAuto,
        engines: ENGINES,
    };
    const timer = setInterval(() => { if (addMenuItem()) clearInterval(timer); }, 1000);
    try {
        const { eventSource, eventTypes } = ctx();
        // After a reply (or a new swipe) is shown in full.
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => { translateNew(id).catch(() => { }); });
        // Swiping to another existing version: SillyTavern drops the old translation, translate this one.
        eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => {
            setTimeout(() => { if (!busy()) translateNew(id).catch(() => { }); }, 300);
        });
    } catch {
        // older SillyTavern: only manual translation
    }
}
