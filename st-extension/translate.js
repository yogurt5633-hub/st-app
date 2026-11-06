// Корректор: translation of messages in the chat.
//
// SillyTavern's own "Translate whole chat" stops at the first error and only says
// "Failed to translate chat", and long replies sometimes come back half in English.
// Here every message is translated on its own:
//  - a chosen translator (Google, Bing, Yandex, DeepL, Lingva) or «Авто», which tries
//    them in turn; or Korrektor's model (better with roleplay, costs a little), through the
//    tavern's connection or with a key of its own just for translation;
//  - long text goes in pieces, several at once; a piece that comes back untranslated or
//    shorter than it should be (the end cut off) is split further or given to the next translator;
//  - a range (last 20 / 50 / all), progress, a Stop button, failed messages can be retried,
//    translations that came out cut off are done again;
//  - one message from its menu (the language button), and optionally every new reply once it is written;
//  - a journal of what happened, to copy and send when something goes wrong.
// The translation goes to message.extra.display_text — the same place SillyTavern's
// translator uses: the original text stays, and "Show original" brings it back.

import { el, sheet, storage, store } from './gallery.js';

const ctx = () => SillyTavern.getContext();
const SETTINGS_KEY = 'korrektor.translate';
const MODEL_API = '/api/plugins/korrektor/translate';
const KEY_API = '/api/plugins/korrektor/translate/key';
// The companion's version, for the journal (the same as in manifest.json).
const COMPANION_VERSION = '0.4.21';

// ---------- journal ----------
// What the translation did: requests, retries, cut answers, errors. Kept in this browser
// (the last 200 lines survive a reload), shown in «Перевод» → «Журнал» with «Копировать».

const LOG_KEY = 'korrektor.translate.log';
const LOG_MAX = 300;
let journal = null;
let journalTimer = null;
const journalWatchers = new Set();

function journalList() {
    if (!journal) {
        journal = storage(LOG_KEY, []);
        if (!Array.isArray(journal)) journal = [];
    }
    return journal;
}

/** One line in the journal. level: info | warn | error. */
export function tlog(level, text) {
    const list = journalList();
    list.push({ t: Date.now(), level, text: String(text).slice(0, 700) });
    if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
    try {
        (level === 'info' ? console.info : console.warn)('[korrektor] перевод:', text);
    } catch {
        // no console
    }
    clearTimeout(journalTimer);
    journalTimer = setTimeout(() => store(LOG_KEY, list.slice(-200)), 400);
    for (const watch of journalWatchers) {
        try {
            watch();
        } catch {
            // a closed sheet
        }
    }
}

export function journalText() {
    const pad = (n) => String(n).padStart(2, '0');
    return journalList().map(({ t, level, text }) => {
        const d = new Date(t);
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${level === 'error' ? '✖' : level === 'warn' ? '⚠' : '·'} ${text}`;
    }).join('\n');
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} с`;

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
// Requests at once, per translator: pieces of one message go in parallel, so a long reply
// takes about as long as its longest piece.
const CONCURRENCY = { google: 4, bing: 3, yandex: 3, lingva: 2, deepl: 3, model: 4 };
// A long message goes to the model in parts of about this size, translated at the same time.
// Shorter messages go whole: one request keeps names and genders consistent.
const MODEL_WHOLE = 4000;
const MODEL_PART = 3000;
// Shown as it goes: a message longer than this goes to the model in parts of about 600 characters,
// at most 6 parts (a longer message gets longer parts), so a rate limit is not hit at once.
const MODEL_GRADUAL_MIN = 800;
const gradualPart = (length) => Math.max(600, Math.ceil(length / 6));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs at most `n` of the given jobs at once. */
function limiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= n || !queue.length) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            active--;
            next();
        });
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

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
        // The translation appears in the message part by part while it is made.
        gradual: saved.gradual ?? true,
        again: false,
    };
}

function saveSettings(s) {
    store(SETTINGS_KEY, { lang: s.lang, engine: s.engine, range: s.range, mine: s.mine, auto: s.auto, gradual: s.gradual });
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

// ---------- a translation that lost its end ----------

/** Letters of a text, HTML tags not counted. */
export function letterCount(text) {
    return (String(text ?? '').replace(/<[^>]*>/g, ' ').match(/\p{L}/gu) || []).length;
}

const SHORT_SCRIPTS = new Set(['ja', 'ko', 'zh-CN', 'zh-TW']);

/**
 * The translation is much shorter than its source: the translator (or the model's length
 * limit) dropped the end. A translation has about as many letters as the original
 * (Russian from English: 0.8–1.1), Chinese, Japanese and Korean far fewer.
 */
export function looksCut(source, out, lang, min = null) {
    const src = letterCount(source);
    if (src < 300) return false;
    const floor = min ?? (SHORT_SCRIPTS.has(lang) ? 0.18 : 0.55);
    if (letterCount(out) < src * floor) return true;
    // Paragraphs and lines are kept by the translators and the model: many fewer lines, and fewer
    // letters too, = a lost end (lines alone may be merged by a model that keeps all the text).
    const lines = (t) => String(t).split('\n').filter(l => l.trim()).length;
    const srcLines = lines(source);
    return srcLines >= 8 && lines(out) < srcLines * 0.6 && letterCount(out) < src * 0.8;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'col', 'area', 'base', 'embed', 'param', 'track']);

/**
 * Cuts a message into parts of about `size` characters at blank lines that are outside
 * HTML blocks and code blocks, so every part is whole markup. Nothing is lost: joined, the parts are the text.
 */
export function splitParts(text, size) {
    if (text.length <= size) return [text];
    const blocks = String(text).split(/(\n[ \t]*\n)/);
    const units = [];
    let unit = '';
    let depth = 0;
    let fence = false;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        unit += block;
        if (i % 2 === 1) continue;
        for (const m of block.matchAll(/```|<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
            if (m[0] === '```') fence = !fence;
            else if (!fence && !VOID_TAGS.has(m[2].toLowerCase()) && !m[3]) depth = Math.max(0, depth + (m[1] ? -1 : 1));
        }
        // A part may end here only outside a block.
        if (!fence && depth === 0) {
            units.push(unit);
            unit = '';
        }
    }
    if (unit) units.push(unit);
    const parts = [];
    let part = '';
    for (const u of units) {
        if (part && part.length + u.length > size) {
            parts.push(part);
            part = '';
        }
        part += u;
    }
    if (part) parts.push(part);
    // Blank lines at the start of a part go to the end of the one before: each part starts with text.
    for (let i = 1; i < parts.length; i++) {
        const lead = parts[i].match(/^\s*/)[0];
        if (lead) {
            parts[i - 1] += lead;
            parts[i] = parts[i].slice(lead.length);
        }
    }
    return parts.filter(p => p !== '');
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
        if (error?.name === 'AbortError') throw Object.assign(new Error(`${who}: не ответил за ${Math.round(ms / 1000)} с`), { timeout: true });
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

async function viaModel(text, lang, signal, label = '', context = null) {
    // X-Korrektor: the plugin may use this tab's session to reach the model.
    const headers = { ...ctx().getRequestHeaders(), 'X-Korrektor': '1' };
    // A paragraph gets about a minute, a whole long reply up to four.
    const limit = Math.min(240000, 45000 + text.length * 40);
    const started = Date.now();
    // context: the whole message, when this is one part of it (read for names and genders, not translated).
    const body = context ? { text, lang, context } : { text, lang };
    const res = await limitedFetch(MODEL_API, { method: 'POST', headers, body: JSON.stringify(body) }, signal, limit, 'модель для перевода');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        tlog('error', `${label}модель: ${data.error || res.status} (${seconds(Date.now() - started)})`);
        throw Object.assign(new Error(data.error || `модель: ${res.status}`), { fatal: res.status === 404 || res.status === 409 || res.status === 400 || res.status === 401 });
    }
    const out = String(data.text ?? '');
    const via = data.via === 'key' ? 'свой ключ' : 'таверна';
    tlog(data.cut ? 'warn' : 'info', `${label}модель ${data.model || ''} (${via}): ${text.length} → ${out.length} зн. за ${seconds(Date.now() - started)}${data.cut ? ' · ответ оборвался на лимите длины' : ''}`);
    if (data.cut) throw Object.assign(new Error('модель: ответ оборвался на лимите длины'), { cut: true });
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
            // A request that ran out of time is not repeated: it would only double the wait.
            // An answer cut at the length limit is not repeated either: it is split instead.
            if (error.fatal || error.stopped || error.timeout || error.cut || error.status === 400 || error.status === 403) break;
            if (i < tries - 1) await sleep(800 * (i + 1) * (i + 1));
        }
    }
    throw last;
}

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
 * How far one message's translation has got, 0…1. Parts already sent count fully; parts being
 * translated now creep forward with time, so the bar moves while requests wait.
 */
export class Tracker {
    constructor(engine) {
        this.engine = engine;
        this.total = 0;
        this.done = 0;
        this.running = new Set();
        this.finished = false;
    }

    plan(chars) {
        this.total = Math.max(1, chars);
    }

    /** A request started; returns its handle for end(). */
    start(chars) {
        const job = { chars, since: Date.now() };
        this.running.add(job);
        return job;
    }

    end(job, count = true) {
        if (!job) return;
        this.running.delete(job);
        if (count) this.done += job.chars;
    }

    fraction() {
        if (this.finished) return 1;
        if (!this.total) return 0;
        let partial = 0;
        const now = Date.now();
        for (const job of this.running) {
            // About how long a request takes: a free translator a second or two, a model longer for longer text.
            const expected = this.engine === 'model' ? Math.max(4000, job.chars * 12) : 1500;
            partial += job.chars * 0.9 * (1 - Math.exp(-(now - job.since) / expected));
        }
        return Math.min(0.99, (this.done + partial) / this.total);
    }
}

const PROBLEMS = { untranslated: 'вернул текст без перевода', short: 'вернул перевод короче оригинала (конец пропал)', cut: 'ответ оборвался на лимите длины' };

/**
 * Translates a piece with one provider, its parts at the same time. A part that comes back
 * untranslated or cut short is split in half and tried again (twice at most); if it still is,
 * the provider has failed (the model keeps such a small part in the original instead).
 */
async function byProvider(provider, text, lang, run, limit = LIMITS[provider], depth = 0) {
    const { signal, tracker, pool, label } = run;
    const call = provider === 'model' ? (part, context = run.context) => viaModel(part, lang, signal, label, context) : (part) => free(provider, part, lang, signal);
    let pieces = provider === 'model' ? splitParts(text, limit) : chunkText(text, limit);
    // One big block without blank lines: cut at lines and sentences instead.
    if (pieces.length === 1 && text.length > limit) pieces = chunkText(text, limit);
    const outs = await Promise.all(pieces.map(async (part) => {
        if (!part.trim()) return part;
        const [, lead, core, tail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const job = tracker?.start(core.length);
        let result = null;
        let problem = '';
        const started = Date.now();
        try {
            const raw = await pool(provider, () => withRetries(() => call(core), 2));
            result = fixMarkup(core, decodeEntities(core, raw));
            // Far longer than its part: the model translated the whole message it was given to read. Once more without it.
            if (provider === 'model' && run.context && letterCount(result) > letterCount(core) * 2 + 200) {
                tlog('warn', `${label}модель перевела больше своей части — повторяю без контекста`);
                result = fixMarkup(core, decodeEntities(core, await pool(provider, () => withRetries(() => call(core, null), 2))));
            }
            if (provider !== 'model') tlog('info', `${label}${provider}: ${core.length} → ${result.length} зн. за ${seconds(Date.now() - started)}`);
        } catch (error) {
            if (!error.cut) {
                if (!error.stopped && provider !== 'model') tlog('warn', `${label}${provider}: ${error.message}`);
                throw error;
            }
            problem = 'cut';
        } finally {
            tracker?.end(job, depth === 0);
        }
        if (!problem && looksUntranslated(core, result, lang)) problem = 'untranslated';
        if (!problem && looksCut(core, result, lang)) problem = 'short';
        if (problem) {
            const canSplit = depth < 2 && core.length > (provider === 'model' ? 400 : 200);
            tlog('warn', `${label}${ENGINE_NAMES[provider] || provider}: ${PROBLEMS[problem]} (${core.length} зн.)${canSplit ? ' — перевожу по частям' : ''}`);
            if (canSplit) {
                result = await byProvider(provider, core, lang, run, Math.ceil(core.length / 2), depth + 1);
            } else if (provider === 'model' && depth > 0) {
                // A small part of a long reply: it stays in the original, the rest is translated.
                run.partial++;
                result = core;
            } else {
                throw Object.assign(new Error(`${ENGINE_NAMES[provider] || provider}: ${PROBLEMS[problem]}`), { untranslated: true });
            }
        }
        return lead + result + tail;
    }));
    return outs.join('');
}

/**
 * The translator for one run. With «Авто» free providers are tried in turn and the one
 * that worked goes first for the rest of the run; a chosen provider is used alone.
 * `label` starts every journal line of this run (for example «#12 »). `onPreview(text)` is called
 * as parts get translated, with the message so far (translated parts over the original).
 */
export function translator(engine, lang, signal = null, tracker = null, { plan = true, label = '', onPreview = null } = {}) {
    let order = engine === 'auto' || engine === 'free' ? [...AUTO] : [engine];
    // A provider that failed twice in a row is skipped for the rest of the run,
    // so a blocked translator costs seconds, not minutes.
    const strikes = new Map();
    const pools = new Map();
    const pool = (provider, fn) => {
        if (!pools.has(provider)) pools.set(provider, limiter(CONCURRENCY[provider] || 3));
        return pools.get(provider)(fn);
    };
    const translateRun = async (run, piece, limit) => {
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
                const out = await byProvider(provider, piece, lang, run, limit);
                strikes.set(provider, 0);
                if (order[0] !== provider) order = [provider, ...order.filter((p) => p !== provider)];
                return out;
            } catch (error) {
                if (error.fatal || error.stopped) throw error;
                last = error;
                strikes.set(provider, (strikes.get(provider) || 0) + 1);
            }
        }
        throw last;
    };
    // Line by line: lines in the target language, lines without letters (borders, numbers) and
    // table borders stay exactly as they are, so status blocks and tables keep their shape.
    // Neighbouring lines that need translating go together, for context. All groups are sent at once.
    // Every piece becomes a slot: its original text and its translation once it is there.
    const translatePiece = (run, piece, add) => {
        if (!piece.trim()) return add(piece, piece);
        let first = true;
        const push = (orig, work) => {
            if (!first) add('\n', '\n');
            first = false;
            add(orig, work);
        };
        let group = [];
        const flush = () => {
            if (!group.length) return;
            // Blank lines at the end of a group stay outside it.
            let tail = 0;
            while (tail < group.length && !group[group.length - 1 - tail].trim()) tail++;
            const body = group.slice(0, group.length - tail);
            const blanks = group.slice(group.length - tail);
            group = [];
            if (body.length) {
                const source = body.join('\n');
                push(source, translateRun(run, source).catch((error) => {
                    // One stubborn piece does not cost the whole reply: it stays in the original.
                    if (!error.untranslated) throw error;
                    run.partial++;
                    tlog('warn', `${run.label}кусок в ${source.length} зн. оставлен в оригинале: ${error.message}`);
                    return source;
                }));
            }
            for (const blank of blanks) push(blank, blank);
        };
        for (const line of piece.split('\n')) {
            if (!line.trim() && group.length) {
                // Paragraphs of one reply go together: fewer requests, more context.
                group.push(line);
            } else if (!needsTranslation(line, lang)) {
                flush();
                push(line, line);
            } else if (TABLE_ROW.test(line)) {
                // A table row: only the text of the cells, the | stay where they are.
                flush();
                const cells = line.split('|');
                push(line, Promise.all(cells.map(async (cell) => {
                    if (!needsTranslation(cell, lang)) return cell;
                    const [, lead, core, tail] = cell.match(/^(\s*)([\s\S]*?)(\s*)$/);
                    return lead + (await translateRun(run, core)).replace(/\|/g, '/').replace(/\n/g, ' ') + tail;
                })).then(done => done.join('|')));
            } else {
                group.push(line);
            }
        }
        flush();
    };
    const translate = async (text) => {
        // What will be sent, for the progress bar: the lines that need translating.
        if (plan) tracker?.plan(text.split('\n').filter(line => needsTranslation(line, lang)).reduce((n, line) => n + line.length + 1, 0));
        // Stops this run's other requests once one has failed for good.
        const inner = new AbortController();
        const onOuter = () => inner.abort();
        if (signal?.aborted) inner.abort();
        else signal?.addEventListener('abort', onOuter, { once: true });
        const run = { signal: inner.signal, outer: signal, tracker, pool, label, partial: 0, context: null };
        // The message as it is so far: translated slots in their places, the rest still in the original.
        const slots = [];
        let closed = false;
        let previewTimer = null;
        const preview = () => {
            if (!onPreview || closed || previewTimer) return;
            previewTimer = setTimeout(() => {
                previewTimer = null;
                if (closed) return;
                try {
                    onPreview(slots.map(x => x.value ?? x.orig).join(''));
                } catch {
                    // the message is gone from the screen
                }
            }, 120);
        };
        const add = (orig, work) => {
            const one = { orig, value: typeof work === 'string' ? work : null };
            one.promise = typeof work === 'string' ? Promise.resolve(work) : work.then((value) => {
                one.value = value;
                preview();
                return value;
            });
            slots.push(one);
        };
        try {
            if (engine === 'model') {
                // The model gets the whole message — markup, blocks and all — and keeps it. A long one
                // goes in parts at once; shown as it goes, in smaller parts, so the beginning comes soon.
                // Each part then gets the whole message to read, for names, genders and who speaks.
                if (!text.split('\n').some(line => needsTranslation(line, lang))) return text;
                const parts = onPreview && text.length > MODEL_GRADUAL_MIN ? splitParts(text, gradualPart(text.length)) : [text];
                if (parts.length > 1) run.context = text;
                for (const part of parts) {
                    if (!part.trim() || !part.split('\n').some(line => needsTranslation(line, lang))) {
                        add(part, part);
                        continue;
                    }
                    const limit = parts.length === 1 && text.length > MODEL_WHOLE ? MODEL_PART : undefined;
                    add(part, translateRun(run, part, limit).catch((error) => {
                        if (!error.untranslated) throw error;
                        tlog('warn', `${label}модель вернула текст без перевода — оставлен оригинал${parts.length > 1 ? ' этой части' : ''}`);
                        run.partial++;
                        return part;
                    }));
                }
            } else {
                // split() with a group keeps the kept pieces in the list.
                for (const piece of text.split(KEEP)) {
                    if (piece === undefined) continue;
                    if (KEEP_ALL.test(piece)) add(piece, piece);
                    else translatePiece(run, piece, add);
                }
            }
            return (await Promise.all(slots.map(x => x.promise))).join('');
        } catch (error) {
            inner.abort();
            // «Стоп» pressed: the error says so, whatever request noticed it first.
            if (signal?.aborted && !error.stopped) throw Object.assign(new Error('Остановлено'), { fatal: true, stopped: true });
            throw error;
        } finally {
            closed = true;
            clearTimeout(previewTimer);
            signal?.removeEventListener('abort', onOuter);
            translate.partial = (translate.partial || 0) + run.partial;
        }
    };
    return translate;
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

const ENGINE_NAMES = { auto: 'Авто', google: 'Google', bing: 'Bing', yandex: 'Яндекс', deepl: 'DeepL', lingva: 'Lingva', model: 'модель' };

/**
 * A saved translation that lost its end: shorter than its source by far. Translations made
 * by this version remember how many letters their source had; older ones (and SillyTavern's
 * own) are compared with the message itself, with more leeway.
 */
export function translationCut(message) {
    const shown = message?.extra?.display_text;
    if (!shown) return false;
    const info = message.extra.korrektor_translation;
    const lang = info?.lang || settings().lang;
    const short = SHORT_SCRIPTS.has(lang);
    if (info?.letters) return info.letters >= 300 && letterCount(shown) < info.letters * (short ? 0.15 : 0.5);
    const raw = String(message.mes || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    const src = letterCount(raw);
    return src >= 300 && letterCount(shown) < src * (short ? 0.15 : 0.45);
}

/** Saves a translation, with what is needed to tell later whether it is whole. */
function markTranslated(message, source, text, engine, lang) {
    if (typeof message.extra !== 'object' || !message.extra) message.extra = {};
    message.extra.display_text = text;
    message.extra.korrektor_translation = { letters: letterCount(source), lang, engine, at: Date.now() };
    // SillyTavern keeps each version (swipe) of a reply with its own extra: the translation stays with this one.
    const swipe = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id] : null;
    if (swipe && typeof swipe === 'object' && swipe.extra && typeof swipe.extra === 'object') {
        swipe.extra.display_text = text;
        swipe.extra.korrektor_translation = message.extra.korrektor_translation;
    }
}

function unmarkTranslated(message) {
    if (!message?.extra) return;
    delete message.extra.display_text;
    delete message.extra.korrektor_translation;
    const swipe = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id] : null;
    if (swipe?.extra) {
        delete swipe.extra.display_text;
        delete swipe.extra.korrektor_translation;
    }
}

function pickMessages(chat, { range, mine, again }) {
    const ids = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || !String(m.mes || '').trim()) continue;
        if (m.is_user && !mine) continue;
        // Translated already — unless the translation lost its end: that one is done again.
        if (!again && m.extra?.display_text && !translationCut(m)) continue;
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
    const node = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!node) return;
    node.classList.remove('kt-partial');
    try {
        ctx().updateMessageBlock(id, message);
    } catch (error) {
        console.debug('[korrektor] could not redraw message', id, error);
        return;
    }
    if (message?.extra?.display_text) checkShown(id, message);
}

/**
 * A translation in progress, drawn in the message but not saved: the parts done so far over the
 * original, the rest still in the original. A thin line at the side shows it is being translated.
 */
function showPreview(id, message, text) {
    const node = document.querySelector(`#chat .mes[mesid="${id}"]`);
    const box = node?.querySelector('.mes_text');
    if (!box) return false;
    try {
        box.innerHTML = ctx().messageFormatting(text, message.name, message.is_system, message.is_user, id, {}, false);
        node.classList.add('kt-partial');
        return true;
    } catch (error) {
        console.debug('[korrektor] could not draw the translation so far', id, error);
        return false;
    }
}

/** The preview is over: the message is drawn from what is saved (the translation, or the original again). */
function endPreview(id, message) {
    const node = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!node?.classList.contains('kt-partial')) return;
    node.classList.remove('kt-partial');
    showMessage(id, message);
}

/** The onPreview of one message's translation, if «по частям» is on. */
function previewer(id, message, gradual) {
    if (!gradual) return null;
    const mes = message.mes;
    // Not over a message that was edited, swiped or is no longer in this chat.
    return (text) => {
        if (ctx().chat?.[id] === message && message.mes === mes) showPreview(id, message, text);
    };
}

/**
 * After a translation is drawn: is all of it on screen? SillyTavern runs the display regexes
 * and its HTML cleaning over the translation too; if they hide most of it, the journal says so.
 */
function shownShare(id, message) {
    const node = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
    const text = message?.extra?.display_text;
    if (!node || !text) return null;
    const want = letterCount(text);
    if (want < 300) return null;
    return { want, shown: letterCount(node.textContent) };
}

function checkShown(id, message) {
    setTimeout(() => {
        const share = shownShare(id, message);
        if (share && share.shown < share.want * 0.6) {
            tlog('warn', `#${id} на экране видно ${share.shown} из ${share.want} букв перевода: часть прячет оформление сообщения (регекс или HTML)`);
        }
    }, 60);
}

/** «Проверить переводы»: which translations of this chat lost their end or are partly hidden on screen. */
export function checkChat() {
    const chat = ctx().chat || [];
    const cut = [];
    const hidden = [];
    let total = 0;
    chat.forEach((message, id) => {
        if (!message?.extra?.display_text) return;
        total++;
        if (translationCut(message)) cut.push(id);
        const share = shownShare(id, message);
        if (share && share.shown < share.want * 0.6) hidden.push(id);
    });
    const list = (ids) => ids.slice(0, 15).map(i => `#${i}`).join(', ') + (ids.length > 15 ? '…' : '');
    const text = !total ? 'В этом чате нет переведённых сообщений'
        : `Переводов в чате: ${total}. Обрезанных: ${cut.length}${cut.length ? ` (${list(cut)}) — «Перевести» переведёт их заново` : ''}. Видно не полностью: ${hidden.length}${hidden.length ? ` (${list(hidden)})` : ''}`;
    tlog(cut.length || hidden.length ? 'warn' : 'info', `проверка чата: ${text}`);
    return { total, cut, hidden, text };
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
    if (ids.length) tlog('info', `перевод чата: ${ids.length} сообщ. · ${ENGINE_NAMES[options.engine] || options.engine} → ${options.lang}`);
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
            const label = `#${id} `;
            const started = Date.now();
            const wasCut = translationCut(message);
            try {
                const source = await prepare(message, id);
                tlog('info', `${label}${wasCut ? 'перевод был обрезан, перевожу заново' : 'начинаю'} · ${ENGINE_NAMES[options.engine] || options.engine} → ${options.lang} · ${source.length} зн.`);
                const gradual = options.gradual ?? settings().gradual;
                const run = translator(options.engine, options.lang, controller.signal, tracker, { label, onPreview: previewer(id, message, gradual) });
                const text = await run(source);
                if (text === source && run.partial) throw Object.assign(new Error('переводчик вернул текст без перевода'), { untranslated: true });
                if (text === source) {
                    // Already in this language: no translation over the original (an old bad one goes away).
                    unmarkTranslated(message);
                    tlog('info', `${label}уже на нужном языке`);
                } else if (looksCut(source, text, options.lang) && message.extra?.display_text && !wasCut) {
                    // A worse translation does not replace a whole one made before.
                    tlog('warn', `${label}новый перевод короче оригинала — оставлен прежний`);
                } else {
                    markTranslated(message, source, text, options.engine, options.lang);
                    tlog(run.partial ? 'warn' : 'info', `${label}готово за ${seconds(Date.now() - started)}: ${source.length} → ${text.length} зн.${run.partial ? ` · кусков в оригинале: ${run.partial}` : ''}`);
                }
                showMessage(id, message);
                state.done++;
                streak = 0;
            } catch (error) {
                if (error.stopped) {
                    state.stopped = true;
                    tlog('info', `${label}остановлено`);
                    endPreview(id, message);
                    break;
                }
                tlog('error', `${label}не переведено: ${error.message}`);
                state.failed.push(id);
                lastError = error;
                streak++;
                endPreview(id, message);
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
            // Drawn from what is saved: the finished translation, or the original after a failure.
            endPreview(id, message);
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
// The translator's own key, as the plugin shows it (never the key itself).
let keyState = null;

async function pluginJson(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { ...ctx().getRequestHeaders(), 'X-Korrektor': '1', ...(init.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Корректор ответил ${res.status}`);
    return data;
}

async function loadModelChoice() {
    try {
        const m = (await pluginJson(SETTINGS_API)).models || {};
        modelChoice = { source: m.translateSource || '', model: m.translate || '' };
    } catch {
        // plugin not reachable: the choice stays as it was
    }
    return modelChoice;
}

async function loadKey() {
    try {
        keyState = await pluginJson(KEY_API);
    } catch {
        // an older plugin without its own key
    }
    return keyState;
}

/** Sets the model that translates; empty = as in Korrektor's settings (its cheap model). */
export async function setModel(source, model) {
    const body = { models: { translateSource: model ? String(source || '') : '', translate: String(model || '') } };
    await pluginJson(SETTINGS_API, { method: 'POST', body: JSON.stringify(body) });
    modelChoice = { source: body.models.translateSource, model: body.models.translate };
    tlog('info', model ? `модель для перевода: ${model}` : 'модель для перевода: дешёвая Корректора');
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

// ---------- one message ----------

/** SillyTavern's own auto-translation would translate the same reply again: leave it only for my messages. */
function quietStAuto() {
    const select = document.getElementById('translation_auto_mode');
    if (!select || !window.jQuery) return;
    const next = select.value === 'both' ? 'inputs' : select.value === 'responses' ? 'none' : null;
    if (next) window.jQuery(select).val(next).trigger('change');
}

const messageQueue = new Set();

/**
 * Translates one message with the chosen translator, shows the progress panel, saves the chat.
 * why: 'auto' (a new reply), 'button' (from the message's menu). Returns true when translated.
 */
async function translateMessage(id, { what = 'ответ', why = 'auto' } = {}) {
    const s = settings();
    const c = ctx();
    const message = c.chat?.[id];
    if (!message || message.is_system || !String(message.mes || '').trim()) return false;
    if (messageQueue.has(id)) {
        if (why === 'button') toastr.info('Это сообщение уже переводится', 'Корректор');
        return false;
    }
    messageQueue.add(id);
    const chatId = c.getCurrentChatId?.();
    const controller = new AbortController();
    const label = `#${id} `;
    let tracker = new Tracker(s.engine);
    const onScreen = showTask({ label: () => `Перевожу ${what}`, fraction: () => tracker.fraction(), stop: () => controller.abort() });
    let outcome = '';
    const started = Date.now();
    try {
        // SillyTavern cuts the thinking out of a new reply a moment after it appears: wait for that.
        if (why === 'auto') await sleep(600);
        let text = null;
        let source = '';
        let engine = s.engine;
        let partial = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            const before = message.mes;
            source = await prepare(message, id);
            tlog('info', `${label}${what}${why === 'button' ? ' (по кнопке)' : ''}: начинаю · ${ENGINE_NAMES[s.engine] || s.engine} → ${s.lang} · ${source.length} зн.`);
            tracker = new Tracker(s.engine);
            engine = s.engine;
            try {
                const run = translator(s.engine, s.lang, controller.signal, tracker, { label, onPreview: previewer(id, message, s.gradual) });
                text = await run(source);
                partial = run.partial || 0;
            } catch (error) {
                if (error.stopped || s.engine !== 'model') throw error;
                // The translation model did not answer or failed: the message still gets translated, by a free translator.
                tlog('warn', `${label}модель не сработала (${error.message}) — перевожу бесплатным переводчиком`);
                toastr.warning(`Модель для перевода не сработала (${error.message}). Перевожу бесплатным переводчиком — выберите другую модель или свой ключ в «Перевод»`, 'Корректор', { timeOut: 9000 });
                tracker = new Tracker('auto');
                engine = 'auto';
                const run = translator('auto', s.lang, controller.signal, tracker, { label, onPreview: previewer(id, message, s.gradual) });
                text = await run(source);
                partial = run.partial || 0;
            }
            // The text changed while it was being translated (thinking cut out, edited): once more.
            if (message.mes === before) break;
            tlog('info', `${label}текст сообщения изменился во время перевода — перевожу ещё раз`);
            text = null;
        }
        // The message may have been edited, swiped or the chat changed meanwhile.
        if (text === null || ctx().getCurrentChatId?.() !== chatId || ctx().chat?.[id] !== message) {
            tlog('info', `${label}сообщение сменилось — перевод не сохранён`);
            return false;
        }
        if (text === source && partial) throw new Error('переводчик вернул текст без перевода. Выберите другой переводчик');
        if (text === source) {
            tlog('info', `${label}уже на нужном языке`);
            if (why === 'button') toastr.info('Сообщение уже на нужном языке', 'Корректор');
            return false;
        }
        if (looksCut(source, text, s.lang)) tlog('warn', `${label}перевод вышел заметно короче оригинала (${letterCount(text)} из ${letterCount(source)} букв)`);
        markTranslated(message, source, text, engine, s.lang);
        showMessage(id, message);
        await ctx().saveChat();
        tlog(partial ? 'warn' : 'info', `${label}готово за ${seconds(Date.now() - started)}: ${source.length} → ${text.length} зн.${partial ? ` · кусков в оригинале: ${partial}` : ''}`);
        return true;
    } catch (error) {
        if (error.stopped) {
            outcome = 'остановлено';
            tlog('info', `${label}остановлено`);
        } else {
            outcome = 'не вышло';
            tlog('error', `${label}не переведено: ${error.message}`);
            toastr.warning(`Не перевёл ${what}: ${error.message}`, 'Корректор', { timeOut: 6000 });
        }
        return false;
    } finally {
        messageQueue.delete(id);
        onScreen.finish(outcome);
        // A part shown and then stopped or failed: the message goes back to what is saved.
        endPreview(id, message);
    }
}

/** A new reply (or the greeting of a new chat), if «Переводить новые ответы» is on. */
async function translateNew(messageId, how = 'rendered') {
    if (!settings().auto) return;
    const id = Number(messageId);
    const chat = ctx().chat || [];
    const message = chat[id];
    if (!message || message.is_user || message.is_system) return;
    // Swiping back to a version translated earlier: its translation is still there.
    if (how === 'swiped' && message.extra?.display_text && !translationCut(message)) return;
    // The first message of a chat is the greeting: translated as soon as a new chat opens.
    const what = chat.findIndex(m => !m.is_system) === id ? 'приветствие' : 'ответ';
    await translateMessage(id, { what, why: 'auto' });
}

/** The language button in a message's menu: translate it, or — when it is translated — again or back to the original. */
async function onMessageButton(id) {
    const message = ctx().chat?.[id];
    if (!message) return;
    if (!message.extra?.display_text) {
        await translateMessage(id, { what: `сообщение #${id}`, why: 'button' });
        return;
    }
    const cut = translationCut(message);
    let box = null;
    const body = el('div', { class: 'kg-translate' },
        el('p', { class: 'kg-hint', text: cut ? 'Перевод этого сообщения обрезан: конец пропал. Переведите заново.' : `Сообщение переведено (${ENGINE_NAMES[settings().engine] || settings().engine} → ${settings().lang}).` }),
        el('div', { class: 'kg-actions' },
            el('button', { type: 'button', class: 'menu_button kg-main', text: 'Перевести заново', onclick: () => { box?.close(); translateMessage(id, { what: `сообщение #${id}`, why: 'button' }); } }),
            el('button', {
                type: 'button', class: 'menu_button', text: 'Показать оригинал', onclick: async () => {
                    box?.close();
                    unmarkTranslated(message);
                    showMessage(id, message);
                    tlog('info', `#${id} показан оригинал`);
                    await ctx().saveChat();
                },
            })),
        el('p', { class: 'kg-hint', text: 'Переводчик и язык — в «Перевод» (меню расширений или строка над таверной).' }));
    box = sheet(`Сообщение #${id}`, body);
}

export function setAuto(on, options = {}) {
    const s = { ...settings(), ...options, auto: Boolean(on) };
    saveSettings(s);
    if (s.auto) quietStAuto();
    tlog('info', `новые ответы: ${s.auto ? `переводить (${ENGINE_NAMES[s.engine] || s.engine} → ${s.lang})` : 'не переводить'}`);
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
            unmarkTranslated(message);
            showMessage(id, message);
            changed++;
        }
    });
    if (changed) await c.saveChat();
    if (changed) tlog('info', `оригинал возвращён в ${changed} сообщ.`);
    return changed;
}

// ---------- the sheets ----------

function seg(options, value, onchange) {
    const box = el('div', { class: 'kg-seg' });
    const draw = (v) => box.replaceChildren(...options.map(([key, label]) =>
        el('button', { type: 'button', class: v === key ? 'on' : '', onclick: () => { draw(key); onchange(key); }, text: label })));
    draw(value);
    return box;
}

function keyLine(key) {
    if (!key?.hasKey) return 'Свой ключ не задан: переводит подключение таверны';
    const state = key.checked ? (key.checked.ok ? ' · ✓ работает' : key.checked.ok === false ? ' · ✖ проверка не прошла' : '') : '';
    return `Свой ключ: ${key.label || key.provider} ${key.keyHint} · ${key.model || 'модель не выбрана'}${key.on ? '' : ' · выключен'}${state}`;
}

/** The translator's own key: whose, which model, «Проверить и сохранить». */
export async function openKeySheet() {
    const cfg = (await loadKey()) || { providers: [] };
    if (!cfg.providers?.length) {
        toastr.warning('Обновите Корректор: эта версия плагина не умеет свой ключ для перевода', 'Корректор');
        return;
    }
    const provider = el('select', { class: 'text_pole' },
        cfg.providers.map(p => el('option', { value: p.id, selected: p.id === (cfg.provider || 'openrouter'), text: p.label })));
    const url = el('input', { class: 'text_pole', type: 'url', placeholder: 'https://адрес-сервера/v1', value: cfg.provider === 'custom' ? cfg.url || '' : '', autocapitalize: 'off', spellcheck: 'false' });
    const kind = el('select', { class: 'text_pole' },
        [['openai', 'Формат OpenAI (chat/completions)'], ['anthropic', 'Формат Anthropic (messages)']].map(([v, t]) => el('option', { value: v, selected: v === cfg.kind, text: t })));
    const customRow = el('div', {}, el('div', { class: 'kg-label', text: 'Адрес сервера и формат' }), url, kind);
    const showCustom = () => { customRow.hidden = provider.value !== 'custom'; };
    provider.addEventListener('change', showCustom);
    showCustom();
    const key = el('input', {
        class: 'text_pole', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
        placeholder: cfg.hasKey ? `сохранён ${cfg.keyHint} — вставьте новый, чтобы заменить` : 'вставьте ключ',
    });
    const listId = 'korrektor-key-models';
    const datalist = el('datalist', { id: listId });
    const model = el('input', { class: 'text_pole', list: listId, value: cfg.model || '', placeholder: 'например google/gemini-2.5-flash или claude-haiku-5-5', autocapitalize: 'off', spellcheck: 'false' });
    const fillModels = (list) => datalist.replaceChildren(...(list || []).slice(0, 1500).map(m => el('option', { value: m })));
    const onBox = el('input', { type: 'checkbox', checked: cfg.on !== false });
    const status = el('div', { class: 'kg-progress', text: cfg.checked?.message || '' });
    const save = async (check) => {
        const body = { provider: provider.value, model: model.value.trim(), on: onBox.checked, check };
        if (provider.value === 'custom') {
            body.url = url.value.trim();
            body.kind = kind.value;
        }
        if (key.value.trim()) body.key = key.value.trim();
        return pluginJson(KEY_API, { method: 'POST', body: JSON.stringify(body) });
    };
    const checkBtn = el('button', { type: 'button', class: 'menu_button kg-main', text: 'Проверить и сохранить' });
    checkBtn.addEventListener('click', async () => {
        if (!cfg.hasKey && !key.value.trim()) {
            status.textContent = 'Сначала вставьте ключ';
            return;
        }
        checkBtn.disabled = true;
        status.textContent = 'Проверяю: прошу модель перевести одну строку…';
        try {
            const out = await save(true);
            Object.assign(cfg, out);
            keyState = out;
            key.value = '';
            key.placeholder = `сохранён ${out.keyHint} — вставьте новый, чтобы заменить`;
            fillModels(out.check?.models);
            status.textContent = out.check?.message || 'Сохранено';
            tlog(out.check?.ok ? 'info' : 'warn', `свой ключ (${out.label}, ${out.model || 'без модели'}): ${out.check?.message || 'сохранён'}`);
        } catch (error) {
            status.textContent = error.message;
            tlog('error', `свой ключ: ${error.message}`);
        } finally {
            checkBtn.disabled = false;
        }
    });
    const removeBtn = el('button', {
        type: 'button', class: 'menu_button', text: 'Убрать ключ', onclick: async () => {
            try {
                keyState = await pluginJson(KEY_API, { method: 'POST', body: JSON.stringify({ clear: true }) });
                status.textContent = 'Ключ удалён: переводит подключение таверны';
                key.placeholder = 'вставьте ключ';
                cfg.hasKey = false;
                tlog('info', 'свой ключ удалён');
            } catch (error) {
                status.textContent = error.message;
            }
        },
    });
    const backBtn = el('button', { type: 'button', class: 'menu_button', text: 'Назад', onclick: () => openTranslate() });
    if (cfg.hasKey) {
        // Fill the model list in the background: the key is there already.
        pluginJson(`${KEY_API}/models`).then(r => fillModels(r.models)).catch(() => { });
    }
    const body = el('div', { class: 'kg-translate' },
        el('div', { class: 'kg-label', text: 'Чей ключ' }), provider,
        customRow,
        el('div', { class: 'kg-label', text: 'Ключ' }), key,
        el('div', { class: 'kg-label', text: 'Модель для перевода' }), model, datalist,
        el('div', { class: 'kg-checks' }, el('label', { class: 'checkbox_label' }, onBox, el('span', { text: 'Переводить этим ключом (выключите — будет переводить подключение таверны)' }))),
        el('div', { class: 'kg-actions' }, checkBtn, removeBtn, backBtn),
        status,
        el('p', { class: 'kg-hint', text: 'Ключ нужен, чтобы перевод не тратил ключ, которым пишет таверна, или чтобы переводила другая, быстрая модель. Он хранится только в этой таверне (папка Корректора), не попадает в резервные копии и синхронизацию и обратно не показывается — видны только последние 4 знака. Запросы перевода идут с ним напрямую к выбранному сервису. Для перевода подходят быстрые модели: Gemini Flash, Claude Haiku, GPT mini, DeepSeek.' }));
    sheet('Свой ключ для перевода', body);
}

/** The journal: what the translation did, to read or copy and send. */
export function openJournal() {
    const pre = el('pre', { class: 'kt-journal' });
    const draw = () => {
        const text = journalText();
        pre.textContent = text || 'Пока пусто: здесь появится, как идёт перевод — запросы, повторы, обрезанные ответы, ошибки.';
        pre.scrollTop = pre.scrollHeight;
    };
    draw();
    journalWatchers.add(draw);
    const status = el('div', { class: 'kg-progress' });
    const body = el('div', { class: 'kg-translate' }, pre,
        el('div', { class: 'kg-actions' },
            el('button', {
                type: 'button', class: 'menu_button kg-main', text: 'Копировать', onclick: async () => {
                    const text = `Корректор ${COMPANION_VERSION} · ${navigator.userAgent}\n${journalText()}`;
                    try {
                        await navigator.clipboard.writeText(text);
                        status.textContent = 'Скопировано: можно вставить в сообщение';
                    } catch {
                        // Clipboard closed (old WebView): select the text to copy by hand.
                        const range = document.createRange();
                        range.selectNodeContents(pre);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                        status.textContent = 'Текст выделен: нажмите «Копировать» в меню выделения';
                    }
                },
            }),
            el('button', { type: 'button', class: 'menu_button', text: 'Проверить переводы чата', onclick: () => { status.textContent = checkChat().text; } }),
            el('button', { type: 'button', class: 'menu_button', text: 'Очистить', onclick: () => { journalList().length = 0; store(LOG_KEY, []); draw(); status.textContent = ''; } }),
            el('button', { type: 'button', class: 'menu_button', text: 'Назад', onclick: () => openTranslate() })),
        status);
    sheet('Журнал перевода', body, () => journalWatchers.delete(draw));
    // The newest lines are at the bottom: show them.
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
}

export function openTranslate(preset = {}) {
    const s = { ...settings(), ...preset };
    const save = () => saveSettings(s);
    const chat = ctx().chat || [];
    const translated = chat.filter((m) => m?.extra?.display_text).length;
    const cut = chat.filter((m) => translationCut(m)).length;

    const lang = el('select', { class: 'text_pole', onchange: (e) => { s.lang = e.target.value; save(); } },
        LANGUAGES.map(([code, label]) => el('option', { value: code, selected: code === s.lang, text: label })));
    const status = el('div', { class: 'kg-progress', text: cut ? `Обрезанных переводов в чате: ${cut}. «Перевести» переведёт их заново` : '' });
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
    const journalBtn = el('button', { type: 'button', class: 'menu_button', text: 'Журнал', onclick: openJournal });
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
    // Which model translates when «Модель Корректора» is chosen: separate from the model of the replies,
    // or a key of its own just for translation.
    const modelRow = el('div', { class: 'kg-model' });
    const drawModelRow = async () => {
        if (s.engine !== 'model') return modelRow.replaceChildren();
        const [choice, key] = await Promise.all([loadModelChoice(), loadKey()]);
        const keyBtn = el('button', { type: 'button', class: 'menu_button', text: key?.hasKey ? 'Изменить ключ' : 'Свой ключ для перевода…', onclick: openKeySheet });
        if (key?.active) {
            modelRow.replaceChildren(
                el('div', { class: 'kg-label', text: 'Чем переводит модель' }),
                el('div', { class: 'kg-progress', text: keyLine(key) }),
                el('div', { class: 'kg-actions' }, keyBtn));
            return;
        }
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
            key ? el('div', { class: 'kg-hint', text: keyLine(key) }) : null,
            key ? el('div', { class: 'kg-actions' }, keyBtn) : null,
        ].filter(Boolean));
    };
    drawModelRow();
    const again = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.again, onchange: (e) => { s.again = e.target.checked; } }), el('span', { text: 'Заново (уже переведённые тоже)' }));
    const gradualBox = el('label', { class: 'checkbox_label' },
        el('input', { type: 'checkbox', checked: s.gradual, onchange: (e) => { s.gradual = e.target.checked; save(); } }),
        el('span', { text: 'Показывать перевод по частям, пока он идёт: готовые куски сразу встают на место оригинала' }));

    const body = el('div', { class: 'kg-translate' },
        el('div', { class: 'kg-label', text: 'На какой язык' }), lang,
        el('div', { class: 'kg-label', text: 'Какие сообщения' }),
        seg([['last20', 'Последние 20'], ['last50', 'Последние 50'], ['all', 'Весь чат']], s.range, (v) => { s.range = v; save(); }),
        el('div', { class: 'kg-label', text: 'Чем переводить' }),
        el('select', { class: 'text_pole', onchange: (e) => { s.engine = e.target.value; save(); drawModelRow(); } },
            ENGINES.map(([key, label]) => el('option', { value: key, selected: key === s.engine, text: label }))),
        modelRow,
        el('div', { class: 'kg-checks' }, mine, again, autoBox, gradualBox),
        el('div', { class: 'kg-actions' }, startBtn, stopBtn, retryBtn),
        bar, status,
        el('div', { class: 'kg-actions' }, originalBtn, journalBtn),
        el('p', { class: 'kg-hint', text: `Перевод только показывается: текст сообщений не меняется, модель видит оригинал. ${translated ? `Сейчас переведено: ${translated}. ` : ''}Одно сообщение — кнопка с языком в меню сообщения (⋯). «Модель Корректора» лучше держит ролевой стиль, но тратит немного денег; ей можно дать свой ключ. Если переводчик возвращает кусок на английском или обрывает конец, Корректор переводит его заново по частям.` }));
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

/**
 * The language button in every message's menu (⋯). It takes the place of SillyTavern's own
 * «Translate message», which sends the whole message to its translator in one piece.
 */
function addMessageButtons() {
    const boxes = document.querySelectorAll('#message_template .extraMesButtons, #chat .mes .extraMesButtons');
    for (const box of boxes) {
        if (box.querySelector('.korrektor_mes_translate')) continue;
        box.prepend(el('div', { class: 'mes_button korrektor_mes_translate fa-solid fa-language interactable', title: 'Перевести (Корректор)', tabindex: '0', role: 'button' }));
    }
    document.body.classList.add('korrektor-translates');
}

export function initTranslate() {
    window.korrektorTranslate = {
        open: openTranslate,
        chat: translateChat,
        one: (id) => translateMessage(Number(id), { what: `сообщение #${id}`, why: 'button' }),
        stop: stopTranslation,
        original: showOriginal,
        running: () => Boolean(running),
        settings,
        setAuto,
        setModel,
        keySheet: openKeySheet,
        log: openJournal,
        check: checkChat,
        journal: journalText,
        translateModel: () => ({ ...modelChoice, key: keyState ? { active: Boolean(keyState.active), label: keyState.label || '', model: keyState.model || '' } : null }),
        engines: ENGINES,
    };
    const timer = setInterval(() => { if (addMenuItem()) clearInterval(timer); }, 1000);
    loadModelChoice();
    loadKey();
    sillyTavernParts();
    addMessageButtons();
    document.addEventListener('click', (e) => {
        const button = e.target?.closest?.('.korrektor_mes_translate');
        if (!button) return;
        const id = Number(button.closest('.mes')?.getAttribute('mesid'));
        if (Number.isInteger(id)) onMessageButton(id).catch((error) => tlog('error', `#${id} ${error.message}`));
    });
    try {
        const { eventSource, eventTypes } = ctx();
        // After a reply (or a new swipe) is shown in full. On opening a chat SillyTavern does not send this.
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => { translateNew(id).catch(() => { }); });
        // Swiping to another version: one translated before keeps its translation, another one is translated.
        eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => {
            setTimeout(() => { if (!busy()) translateNew(id, 'swiped').catch(() => { }); }, 300);
        });
        // Messages drawn before this script ran get the language button too.
        for (const type of [eventTypes.CHAT_CHANGED, eventTypes.MORE_MESSAGES_LOADED]) {
            if (type) eventSource.on(type, () => setTimeout(addMessageButtons, 50));
        }
    } catch {
        // older SillyTavern: only manual translation
    }
}
