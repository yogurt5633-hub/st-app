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
const LIMITS = { google: 1800, bing: 1000, yandex: 1500, lingva: 900, deepl: 4000, model: 11000 };
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
        // Translated paragraphs shown under a reply while it is being written.
        live: Boolean(saved.live),
        again: false,
    };
}

function saveSettings(s) {
    store(SETTINGS_KEY, { lang: s.lang, engine: s.engine, range: s.range, mine: s.mine, auto: s.auto, live: s.live });
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

/**
 * A signal for one request: stops on «Стоп» (the run's signal) or after `ms` without an answer,
 * so a translator that never answers cannot hang the translation.
 */
function requestSignal(outer, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const onOuter = () => controller.abort();
    if (outer) {
        if (outer.aborted) controller.abort();
        else outer.addEventListener('abort', onOuter, { once: true });
    }
    const done = () => {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onOuter);
    };
    controller.signal.addEventListener('abort', done, { once: true });
    return { signal: controller.signal, done };
}

/** fetch() with a time limit; «Стоп» turns into a fatal «stopped» error. */
async function limitedFetch(url, init, outer, ms, who) {
    const { signal, done } = requestSignal(outer, ms);
    try {
        const res = await fetch(url, { ...init, signal });
        // The body is read right after; the limit stays until then is not needed.
        return res;
    } catch (error) {
        if (outer?.aborted) throw Object.assign(new Error('Остановлено'), { fatal: true, stopped: true });
        if (error?.name === 'AbortError') throw new Error(`${who}: не ответил за ${Math.round(ms / 1000)} с`);
        throw error;
    } finally {
        done();
    }
}

async function free(provider, text, lang, signal) {
    const headers = ctx().getRequestHeaders();
    const body = provider === 'yandex' ? { chunks: [text], lang }
        : provider === 'deepl' ? { text, lang, endpoint: ctx().extensionSettings?.translate?.deepl_endpoint || 'free' }
            : { text, lang };
    const res = await limitedFetch(`/api/translate/${provider}`, { method: 'POST', headers, body: JSON.stringify(body) }, signal, 30000, provider);
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

async function viaModel(text, lang, signal) {
    // X-Korrektor: the plugin may use this tab's session to reach the model.
    const headers = { ...ctx().getRequestHeaders(), 'X-Korrektor': '1' };
    const res = await limitedFetch(MODEL_API, { method: 'POST', headers, body: JSON.stringify({ text, lang }) }, signal, 180000, 'модель');
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
            if (error.fatal || error.stopped || error.status === 400 || error.status === 403) break;
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

/**
 * How far one message's translation has got, 0…1. Parts already sent count fully; the part
 * being translated now creeps forward with time, so the bar moves while a request waits.
 */
export class Tracker {
    constructor(engine) {
        this.engine = engine;
        this.total = 0;
        this.done = 0;
        this.current = 0;
        this.since = 0;
        this.finished = false;
    }

    plan(chars) {
        this.total = Math.max(1, chars);
    }

    start(chars) {
        this.current = chars;
        this.since = Date.now();
    }

    end(chars) {
        this.done += chars;
        this.current = 0;
    }

    fraction() {
        if (this.finished) return 1;
        if (!this.total) return 0;
        let partial = 0;
        if (this.current) {
            // About how long a request takes: a free translator a second or two, a model longer for longer text.
            const expected = this.engine === 'model' ? Math.max(4000, this.current * 15) : 1500;
            partial = this.current * 0.9 * (1 - Math.exp(-(Date.now() - this.since) / expected));
        }
        return Math.min(0.99, (this.done + partial) / this.total);
    }
}

async function byProvider(provider, text, lang, limit = LIMITS[provider], depth = 0, signal = null, tracker = null) {
    const call = provider === 'model' ? (part) => viaModel(part, lang, signal) : (part) => free(provider, part, lang, signal);
    let out = '';
    for (const part of chunkText(text, limit)) {
        if (!part.trim()) {
            out += part;
            continue;
        }
        const [, lead, core, tail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
        tracker?.start(core.length);
        let result;
        try {
            result = fixMarkup(core, decodeEntities(core, await withRetries(() => call(core), 2)));
        } finally {
            tracker?.end(depth ? 0 : core.length);
        }
        if (looksUntranslated(core, result, lang)) {
            if (depth < 2 && core.length > 200) result = await byProvider(provider, core, lang, Math.ceil(core.length / 2), depth + 1, signal, tracker);
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
export function translator(engine, lang, signal = null, tracker = null) {
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
                const out = await byProvider(provider, piece, lang, undefined, 0, signal, tracker);
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
        // What will be sent, for the progress bar: the lines that need translating.
        tracker?.plan(text.split('\n').filter(line => needsTranslation(line, lang)).reduce((n, line) => n + line.length + 1, 0));
        if (engine === 'model') {
            // The model gets the whole message at once — markup, blocks and all — and keeps it.
            if (!text.split('\n').some(line => needsTranslation(line, lang))) return text;
            try {
                return await translateRun(text);
            } catch (error) {
                if (error.untranslated) return text;
                throw error;
            }
        }
        let out = '';
        // split() with a group keeps the kept pieces in the list.
        for (const piece of text.split(KEEP)) {
            if (piece === undefined) continue;
            out += KEEP_ALL.test(piece) ? piece : await translatePiece(piece);
        }
        return out;
    };
}

// ---------- progress on screen ----------
// A small panel at the top of the tavern: what is being translated, percent, a moving bar,
// ✕ to stop. For new replies (and a new chat's greeting) and for translating the chat.

const tasks = new Map();
let taskSeq = 0;
let panel = null;
let ticker = null;

function drawTasks() {
    if (!tasks.size) {
        panel?.remove();
        panel = null;
        clearInterval(ticker);
        ticker = null;
        return;
    }
    if (!panel || !panel.isConnected) {
        panel = el('div', { class: 'kt-progress', role: 'status', 'aria-live': 'polite' });
        document.body.append(panel);
    }
    const rows = [];
    for (const task of tasks.values()) {
        const percent = Math.round(Math.max(0, Math.min(1, task.fraction())) * 100);
        rows.push(el('div', { class: 'kt-task' },
            el('div', { class: 'kt-line' },
                el('span', { class: 'kt-label', text: task.label() }),
                el('b', { text: task.message || `${percent}%` }),
                task.stop && !task.closing ? el('button', { class: 'kt-x', type: 'button', title: 'Остановить', onclick: task.stop, text: '✕' }) : null),
            el('div', { class: 'kt-bar' }, el('i', { style: `width:${task.message ? 100 : percent}%` }))));
    }
    panel.replaceChildren(...rows);
    // Running translation: the sheet follows the same clock.
    if (running) notify(running);
}

/** Shows a translation on screen until finish() is called. */
function showTask({ label, fraction, stop }) {
    const id = ++taskSeq;
    const task = { label, fraction, stop, message: '' };
    tasks.set(id, task);
    if (!ticker) ticker = setInterval(drawTasks, 200);
    drawTasks();
    return {
        finish(message = '') {
            task.closing = true;
            task.fraction = () => 1;
            task.message = message;
            drawTasks();
            setTimeout(() => { tasks.delete(id); drawTasks(); }, message ? 2500 : 700);
        },
    };
}

// ---------- the run ----------

let running = null;
// Sheets that show the run in progress (also one opened again while it runs).
const watchers = new Set();
function notify(state) {
    for (const watch of watchers) {
        try {
            watch(state);
        } catch {
            // a closed sheet
        }
    }
}

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

// SillyTavern's own regex engine and reasoning parser: what is translated is the message as it
// is shown — thinking cut out, display regexes applied (status/info blocks made from markers).
let stParts = null;
async function sillyTavernParts() {
    if (stParts) return stParts;
    const load = async (path) => {
        try {
            return await import(path);
        } catch {
            return null;
        }
    };
    stParts = { regex: await load('../../regex/engine.js'), reasoning: await load('../../../reasoning.js') };
    return stParts;
}

/** The text of a message as SillyTavern shows it, before translation. */
async function prepare(message, id) {
    let text = String(message.mes);
    const { reasoning } = await sillyTavernParts();
    try {
        // A thinking block still in the text (it is cut out a moment after the reply arrives).
        if (reasoning?.removeReasoningFromString) text = reasoning.removeReasoningFromString(text);
    } catch {
        // keep the text as it is
    }
    return displayForm(text, message, id);
}

/** Any text of a message (all of it, or one paragraph) with macros filled and display regexes applied. */
async function displayForm(raw, message, id) {
    const c = ctx();
    let text = String(raw)
        .replace(/\{\{user\}\}/gi, c.name1 || '{{user}}')
        .replace(/\{\{char\}\}/gi, message.is_user ? (c.name2 || '{{char}}') : (message.name || c.name2 || '{{char}}'));
    const { regex } = await sillyTavernParts();
    try {
        if (regex?.getRegexedString) {
            // The same call SillyTavern makes before showing a message: display-only regexes
            // turn markers like [STATUS] into blocks and hide what should be hidden. Translating
            // after them keeps the markers out of the translator's hands.
            const placement = message.is_user ? 1 : message.extra?.type === 'narrator' ? 3 : 2;
            const usable = (c.chat || []).map((m, i) => ({ m, i })).filter(x => !x.m.is_system);
            const at = usable.findIndex(x => x.i === Number(id));
            text = regex.getRegexedString(text, placement, {
                characterOverride: message.name,
                isMarkdown: true,
                depth: at >= 0 ? usable.length - at - 1 : undefined,
            });
        }
    } catch {
        // without regexes: the raw text
    }
    return text;
}

/**
 * Redraws a message if it is on screen. SillyTavern shows only the latest messages and fails
 * on one that is not drawn; that one shows its translation when it is scrolled to.
 */
function showMessage(id, message) {
    if (!document.querySelector(`#chat .mes[mesid="${id}"]`)) return;
    try {
        ctx().updateMessageBlock(id, message);
    } catch (error) {
        console.debug('[korrektor] could not redraw message', id, error);
    }
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
    if (running) {
        // A run that has shown no sign of life for 3 minutes is stuck: it gives way.
        if (Date.now() - running.lastTick > 180000) stopTranslation();
        else throw new Error('Перевод уже идёт');
    }
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    const chat = c.chat;
    if (!chatId || !chat?.length) throw new Error('Откройте чат');
    const ids = options.ids || pickMessages(chat, options);
    const controller = new AbortController();
    let tracker = new Tracker(options.engine);
    const state = { done: 0, total: ids.length, failed: [], stopped: false, error: '', current: 0, lastTick: Date.now(), controller, finished: false };
    // Overall progress: finished messages plus how far the current one has got.
    state.fraction = () => (state.total ? Math.min(1, (state.done + state.failed.length + (state.current ? tracker.fraction() : 0)) / state.total) : 1);
    running = state;
    const onScreen = ids.length ? showTask({
        label: () => (state.current ? `Перевожу чат: ${state.current} из ${state.total}` : `Перевожу чат: ${state.done + state.failed.length} из ${state.total}`),
        fraction: state.fraction,
        stop: stopTranslation,
    }) : null;
    const tick = () => {
        state.lastTick = Date.now();
        onProgress(state);
        notify(state);
    };
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
            state.current = state.done + state.failed.length + 1;
            tracker = new Tracker(options.engine);
            tick();
            try {
                const source = await prepare(message, id);
                const text = await translator(options.engine, options.lang, controller.signal, tracker)(source);
                if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
                // Already in this language: no translation over the original (an old bad one goes away).
                if (text === source) delete message.extra.display_text;
                else message.extra.display_text = text;
                showMessage(id, message);
                state.done++;
                streak = 0;
            } catch (error) {
                if (error.stopped) {
                    state.stopped = true;
                    break;
                }
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
            state.current = 0;
            tick();
            if (state.done && state.done % 10 === 0) await ctx().saveChat();
            if (options.engine !== 'model') await sleep(250);
        }
        if (state.done) await ctx().saveChat();
        if (!state.error && state.failed.length && lastError) state.error = lastError.message;
        return state;
    } finally {
        running = null;
        state.finished = true;
        notify(state);
        onScreen?.finish(state.stopped ? 'остановлено' : state.failed.length ? `не вышло: ${state.failed.length}` : '');
    }
}

// ---------- which model translates (Korrektor's settings, separate from the tavern's reply model) ----------

const SETTINGS_API = '/api/plugins/korrektor/settings';
let modelChoice = { source: '', model: '' };

async function loadModelChoice() {
    try {
        const res = await fetch(SETTINGS_API, { headers: { ...ctx().getRequestHeaders(), 'X-Korrektor': '1' } });
        if (!res.ok) return modelChoice;
        const m = (await res.json()).models || {};
        modelChoice = { source: m.translateSource || '', model: m.translate || '' };
    } catch {
        // plugin not reachable: the choice stays as it was
    }
    return modelChoice;
}

/** Sets the model that translates; empty = as in Korrektor's settings (its cheap model). */
export async function setModel(source, model) {
    const body = { models: { translateSource: model ? String(source || '') : '', translate: String(model || '') } };
    const res = await fetch(SETTINGS_API, { method: 'POST', headers: { ...ctx().getRequestHeaders(), 'X-Korrektor': '1' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Не сохранилось: ${res.status}`);
    modelChoice = { source: body.models.translateSource, model: body.models.translate };
    return modelChoice;
}

/** The tavern's Chat Completion source and the models it lists (the same list as in its own menu). */
function tavernModels() {
    const $ = window.jQuery;
    if (!$ || $('#main_api').val() !== 'openai') return { source: '', models: [] };
    const source = $('#chat_completion_source').val();
    const map = { makersuite: 'model_google_select', vertexai: 'model_vertexai_select', custom: 'model_custom_select' };
    const select = document.getElementById(map[source] || `model_${source}_select`);
    const models = select ? [...select.options].map(o => o.value).filter(Boolean) : [];
    const custom = source === 'custom' ? document.getElementById('custom_model_id')?.value : '';
    if (custom && !models.includes(custom)) models.unshift(custom);
    return { source, models: models.slice(0, 1500) };
}

// ---------- while a reply is being written ----------
// Each finished paragraph is translated in the background, while the model writes the next one.
// When the reply is done only the last paragraph is left. The thinking is never sent: nothing
// is taken until the reasoning block is closed, and the final translation is assembled from the
// finished message (thinking cut out), so a paragraph of thinking could never get into it anyway.

let live = null;

function resetLive() {
    live?.controller.abort();
    live?.box?.remove();
    live = null;
}

/** The reply part of the streamed text, or null while the model is still thinking. */
function replyPart(text) {
    const r = ctx().powerUserSettings?.reasoning;
    if (!r?.auto_parse || !r.prefix || !r.suffix) return text;
    const prefixInPrompt = stParts?.reasoning?.PromptReasoning?.getLatestPrefix?.() || '';
    if (!String(text).trimStart().startsWith(r.prefix) && !prefixInPrompt) return text;
    const end = text.indexOf(r.suffix);
    return end < 0 ? null : text.slice(end + r.suffix.length);
}

function drawLive() {
    if (!live || !settings().live) return;
    const block = document.querySelector(`#chat .mes[mesid="${live.id}"] .mes_block`);
    if (!block) return;
    const done = live.order.filter(key => live.ready.has(key)).map(key => live.ready.get(key));
    if (!done.length) return;
    if (!live.box || !live.box.isConnected) {
        live.box = el('div', { class: 'kt-live', title: 'Перевод по ходу ответа' });
        block.append(live.box);
    }
    live.box.textContent = done.join('\n\n');
}

async function onStream(text) {
    const s = settings();
    if (!s.auto) return;
    const c = ctx();
    const id = Number(c.streamingProcessor?.messageId ?? c.chat.length - 1);
    const message = c.chat?.[id];
    if (!message || message.is_user || message.is_system) return;
    await sillyTavernParts();
    if (!live || live.id !== id || live.engine !== s.engine || live.lang !== s.lang) {
        resetLive();
        live = { id, engine: s.engine, lang: s.lang, controller: new AbortController(), cache: new Map(), ready: new Map(), order: [], chain: Promise.resolve(), box: null };
    }
    const reply = replyPart(String(text || ''));
    if (reply === null) return;
    // The last paragraph is still being written.
    const finished = reply.split(/\n{2,}/).slice(0, -1);
    for (const paragraph of finished) {
        if (!paragraph.trim()) continue;
        // Keys without the spaces and line breaks around: the finished message may have them trimmed.
        const key = (await displayForm(paragraph.trim(), message, id)).trim();
        if (!key.trim() || live.cache.has(key)) continue;
        const current = live;
        const job = current.chain.then(() => translator(current.engine, current.lang, current.controller.signal)(key));
        current.chain = job.catch(() => { });
        current.cache.set(key, job);
        current.order.push(key);
        job.then((out) => {
            current.ready.set(key, out);
            if (current === live) drawLive();
        }, () => { });
    }
}

/**
 * The finished reply translated with what was done while it was written: paragraphs already
 * translated are taken as they are, the rest are translated now.
 */
async function assemble(source, id, s, signal, tracker) {
    const parts = source.split(/(\n{2,})/);
    const cache = live && live.id === id && live.engine === s.engine && live.lang === s.lang ? live.cache : null;
    const todo = parts.filter((p, i) => i % 2 === 0 && p.trim() && !cache?.has(p.trim()));
    tracker?.plan(todo.reduce((n, p) => n + p.length, 0) || 1);
    const translate = translator(s.engine, s.lang, signal, tracker);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i % 2 === 1 || !part.trim()) {
            out.push(part);
            continue;
        }
        let text = null;
        const core = part.trim();
        if (cache?.has(core)) {
            try {
                const [, lead, , tail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
                text = lead + await cache.get(core) + tail;
            } catch {
                text = null;
            }
        }
        out.push(text ?? await translate(part));
    }
    return out.join('');
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
    const controller = new AbortController();
    let tracker = new Tracker(s.engine);
    // The first message of a chat is the greeting: translated as soon as a new chat opens.
    const what = c.chat.findIndex(m => !m.is_system) === id ? 'приветствие' : 'ответ';
    const onScreen = showTask({ label: () => `Перевожу ${what}`, fraction: () => tracker.fraction(), stop: () => controller.abort() });
    let outcome = '';
    try {
        // SillyTavern cuts the thinking out of a new reply a moment after it appears: wait for that.
        await sleep(600);
        let text = null;
        let source = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const before = message.mes;
            source = await prepare(message, id);
            tracker = new Tracker(s.engine);
            // Written with streaming: paragraphs translated meanwhile are used; otherwise all at once.
            text = live && live.id === id && live.cache.size
                ? await assemble(source, id, s, controller.signal, tracker)
                : await translator(s.engine, s.lang, controller.signal, tracker)(source);
            // The text changed while it was being translated (thinking cut out, edited): once more.
            if (message.mes === before) break;
            text = null;
        }
        // The reply may have been edited, swiped or the chat changed meanwhile.
        if (text === null || ctx().getCurrentChatId?.() !== chatId || ctx().chat?.[id] !== message) return;
        if (text === source) return;
        if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
        message.extra.display_text = text;
        if (live?.id === id) {
            live.box?.remove();
            live.box = null;
        }
        showMessage(id, message);
        await ctx().saveChat();
    } catch (error) {
        if (error.stopped) {
            outcome = 'остановлено';
        } else {
            outcome = 'не вышло';
            toastr.warning(`Не перевёл ${what}: ${error.message}`, 'Корректор', { timeOut: 6000 });
        }
    } finally {
        autoQueue.delete(id);
        onScreen.finish(outcome);
        if (live?.id === id) {
            live.box?.remove();
            live.box = null;
        }
    }
}

export function setAuto(on, options = {}) {
    const s = { ...settings(), ...options, auto: Boolean(on) };
    saveSettings(s);
    if (s.auto) quietStAuto();
    return s;
}

export function stopTranslation() {
    if (!running) return;
    running.stopped = true;
    // The request already sent is cut off too, not waited for.
    running.controller?.abort();
}

export async function showOriginal() {
    const c = ctx();
    let changed = 0;
    c.chat?.forEach((message, id) => {
        if (message?.extra?.display_text) {
            delete message.extra.display_text;
            showMessage(id, message);
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

    const showProgress = (st) => {
        bar.hidden = false;
        startBtn.disabled = true;
        stopBtn.hidden = false;
        retryBtn.hidden = true;
        const fill = bar.firstChild;
        const percent = Math.round((st.fraction ? st.fraction() : 0) * 100);
        fill.style.width = `${percent}%`;
        const now = st.current ? `Перевожу ${st.current} из ${st.total} · ${percent}%` : `Переведено ${st.done} из ${st.total} · ${percent}%`;
        status.textContent = `${now}${st.failed.length ? ` · не вышло: ${st.failed.length}` : ''}${st.stopped ? ' · останавливаю…' : ''}`;
    };
    const showResult = (result) => {
        startBtn.disabled = false;
        stopBtn.hidden = true;
        if (!result.total) status.textContent = s.again ? 'Нечего переводить' : 'Всё в этом диапазоне уже переведено. Включите «Заново», чтобы перевести ещё раз';
        else status.textContent = `${result.stopped && !result.error ? 'Остановлено. ' : ''}Переведено ${result.done} из ${result.total}.${result.failed.length ? ` Не вышло: ${result.failed.length}.` : ''}${result.error ? ` ${result.error}` : ''}`;
        retryIds = result.failed.length ? result.failed : null;
        retryBtn.hidden = !retryIds;
    };
    // The sheet follows the run, also one started before the sheet was opened.
    const watch = (st) => (st.finished ? showResult(st) : showProgress(st));
    watchers.add(watch);
    if (running) showProgress(running);
    const run = async (ids = null) => {
        status.textContent = 'Начинаю…';
        bar.hidden = false;
        bar.firstChild.style.width = '0%';
        try {
            const result = await translateChat({ ...s, ids });
            if (result.done) toastr.success(`Переведено сообщений: ${result.done}`, 'Корректор');
        } catch (error) {
            status.textContent = error.message;
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
        el('span', { text: 'Переводить новые ответы сразу (и приветствие нового чата), этим же переводчиком' }));
    const liveBox = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.live, onchange: (e) => { s.live = e.target.checked; save(); } }),
        el('span', { text: 'Показывать перевод под ответом, пока он пишется' }));
    // Which model translates when «Модель Корректора» is chosen: separate from the model of the replies.
    const modelRow = el('div', { class: 'kg-model' });
    const drawModelRow = async () => {
        if (s.engine !== 'model') return modelRow.replaceChildren();
        const choice = await loadModelChoice();
        const { source, models } = tavernModels();
        const list = [...new Set([...(choice.model ? [choice.model] : []), ...models])];
        const select = el('select', {
            class: 'text_pole', onchange: async (e) => {
                try {
                    await setModel(e.target.value ? (choice.model === e.target.value ? choice.source || source : source) : '', e.target.value);
                    toastr.success(e.target.value ? `Переводит: ${e.target.value}` : 'Переводит дешёвая модель Корректора', 'Корректор');
                } catch (error) {
                    toastr.error(error.message, 'Корректор');
                }
            },
        }, el('option', { value: '', selected: !choice.model, text: 'Как в настройках Корректора (дешёвая)' }),
        list.map(m => el('option', { value: m, selected: m === choice.model, text: m })));
        modelRow.replaceChildren(...[
            el('div', { class: 'kg-label', text: 'Модель для перевода (ответы в таверне пишет другая — та, что выбрана в таверне)' }),
            select,
            models.length ? null : el('div', { class: 'kg-hint', text: 'Список моделей берётся из подключения таверны. Другую модель можно указать в Корректоре → Настройки → «Для перевода»' }),
        ].filter(Boolean));
    };
    drawModelRow();
    const again = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.again, onchange: (e) => { s.again = e.target.checked; } }), el('span', { text: 'Заново (уже переведённые тоже)' }));

    const body = el('div', { class: 'kg-translate' },
        el('div', { class: 'kg-label', text: 'На какой язык' }), lang,
        el('div', { class: 'kg-label', text: 'Какие сообщения' }),
        seg([['last20', 'Последние 20'], ['last50', 'Последние 50'], ['all', 'Весь чат']], s.range, (v) => { s.range = v; save(); }),
        el('div', { class: 'kg-label', text: 'Чем переводить' }),
        el('select', { class: 'text_pole', onchange: (e) => { s.engine = e.target.value; save(); drawModelRow(); } },
            ENGINES.map(([key, label]) => el('option', { value: key, selected: key === s.engine, text: label }))),
        modelRow,
        el('div', { class: 'kg-checks' }, mine, again, autoBox, liveBox),
        el('div', { class: 'kg-actions' }, startBtn, stopBtn, retryBtn),
        bar, status,
        el('div', { class: 'kg-actions' }, originalBtn),
        el('p', { class: 'kg-hint', text: `Перевод только показывается: текст сообщений не меняется, модель видит оригинал. ${translated ? `Сейчас переведено: ${translated}. ` : ''}«Модель Корректора» — дешёвая модель из настроек Корректора: лучше держит ролевой стиль, но тратит немного денег. Если переводчик возвращает кусок на английском, Корректор переводит его заново по частям или другим переводчиком.` }));
    sheet('Перевод чата', body, () => watchers.delete(watch));
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
        setModel,
        translateModel: () => modelChoice,
        // For checking what was translated in advance while a reply was written.
        liveState: () => (live ? { id: live.id, keys: [...live.order], ready: live.ready.size, box: Boolean(live.box?.isConnected) } : null),
        engines: ENGINES,
    };
    const timer = setInterval(() => { if (addMenuItem()) clearInterval(timer); }, 1000);
    loadModelChoice();
    sillyTavernParts();
    try {
        const { eventSource, eventTypes } = ctx();
        // After a reply (or a new swipe) is shown in full.
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => { translateNew(id).catch(() => { }); });
        // While a reply is being written: paragraphs are translated as they are finished.
        // The handler returns at once, so streaming itself is never slowed down.
        eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (text) => { onStream(text).catch(() => { }); });
        // A new generation, a stop, another chat: what was translated in advance is thrown away.
        // Background generations (Summarize, quiet prompts) and dry runs (token counting) are not a new reply.
        eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
            if (dryRun || type === 'quiet' || options?.quiet_prompt) return;
            resetLive();
        });
        eventSource.on(eventTypes.CHAT_CHANGED, () => resetLive());
        // Swiping to another existing version: SillyTavern drops the old translation, translate this one.
        eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => {
            setTimeout(() => { if (!busy()) translateNew(id).catch(() => { }); }, 300);
        });
    } catch {
        // older SillyTavern: only manual translation
    }
}
