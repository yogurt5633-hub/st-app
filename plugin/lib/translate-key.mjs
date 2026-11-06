// A key of its own for the translator: the person may give translation a separate key
// (OpenRouter, OpenAI, Claude, Gemini, DeepSeek, Mistral or any OpenAI-compatible address),
// so translating does not spend the key the tavern writes replies with.
//
// The key is kept in korrektor/translate-key.json of this SillyTavern user. Like the catalog
// token it is never sent back to the page, never synced and never packed into backups:
// the page only learns that a key is there and its last four characters.
// Requests go from this plugin straight to the provider.

import fs from 'node:fs';
import path from 'node:path';
import { stripThinking } from './llm.mjs';
import { CUT_REASONS, sseParser, streamDelta } from './sse.mjs';
import { httpError, readJson, writeJson } from './util.mjs';

export const KEY_FILE = 'translate-key.json';

export const PROVIDERS = {
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', kind: 'openai' },
    openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', kind: 'openai' },
    anthropic: { label: 'Anthropic (Claude)', url: 'https://api.anthropic.com/v1', kind: 'anthropic' },
    google: { label: 'Google AI Studio (Gemini)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai' },
    deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', kind: 'openai' },
    mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1', kind: 'openai' },
    custom: { label: 'Свой адрес (OpenAI-совместимый)', url: '', kind: 'openai' },
};

const ANTHROPIC_VERSION = '2026-10-21';

function cleanUrl(value) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    if (!url) return '';
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw httpError(400, 'Адрес должен начинаться с https:// (или http:// для своего сервера)');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw httpError(400, 'Адрес должен начинаться с https:// или http://');
    // An address pasted with the method at the end: the base is enough.
    return url.replace(/\/(chat\/completions|messages|completions)$/, '');
}

export async function readKeyConfig(korrektorDir) {
    const cfg = await readJson(path.join(korrektorDir, KEY_FILE), {});
    const provider = PROVIDERS[cfg.provider] ? cfg.provider : '';
    return {
        provider,
        url: typeof cfg.url === 'string' ? cfg.url : '',
        kind: cfg.kind === 'anthropic' ? 'anthropic' : 'openai',
        key: typeof cfg.key === 'string' ? cfg.key : '',
        model: typeof cfg.model === 'string' ? cfg.model : '',
        on: cfg.on !== false,
        checked: cfg.checked && typeof cfg.checked === 'object' ? cfg.checked : null,
    };
}

/** What the page may see: never the key itself. */
export function publicKeyConfig(cfg) {
    return {
        provider: cfg.provider,
        label: PROVIDERS[cfg.provider]?.label || '',
        url: cfg.provider === 'custom' ? cfg.url : (PROVIDERS[cfg.provider]?.url || ''),
        kind: cfg.kind,
        model: cfg.model,
        on: cfg.on,
        hasKey: Boolean(cfg.key),
        keyHint: cfg.key ? `…${cfg.key.slice(-4)}` : '',
        active: Boolean(cfg.on && cfg.key && cfg.model && cfg.provider),
        checked: cfg.checked,
        providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, url: p.url, kind: p.kind })),
    };
}

/**
 * Saves the choice. The key is replaced only when a new one is given; `clear` removes
 * everything. Changing the provider without a new key keeps the old key (the person may
 * have picked the wrong item first).
 */
export async function saveKeyConfig(korrektorDir, patch = {}) {
    const file = path.join(korrektorDir, KEY_FILE);
    if (patch.clear) {
        await fs.promises.rm(file, { force: true });
        return readKeyConfig(korrektorDir);
    }
    const cfg = await readKeyConfig(korrektorDir);
    if (patch.provider !== undefined) {
        if (!PROVIDERS[patch.provider]) throw httpError(400, 'Выберите, чей это ключ');
        cfg.provider = patch.provider;
    }
    if (patch.url !== undefined) cfg.url = cleanUrl(patch.url);
    if (patch.kind !== undefined) cfg.kind = patch.kind === 'anthropic' ? 'anthropic' : 'openai';
    if (typeof patch.key === 'string' && patch.key.trim()) cfg.key = patch.key.trim();
    if (patch.model !== undefined) cfg.model = String(patch.model || '').trim().slice(0, 200);
    if (patch.on !== undefined) cfg.on = Boolean(patch.on);
    if (patch.checked !== undefined) cfg.checked = patch.checked;
    if (cfg.provider === 'custom' && !cfg.url && (patch.url !== undefined || patch.provider !== undefined)) {
        throw httpError(400, 'Укажите адрес сервера, например https://example.com/v1');
    }
    await writeJson(file, cfg);
    await fs.promises.chmod(file, 0o600).catch(() => { });
    return cfg;
}

function baseUrl(cfg) {
    return cfg.provider === 'custom' ? cfg.url : PROVIDERS[cfg.provider]?.url;
}

function kindOf(cfg) {
    return cfg.provider === 'custom' ? cfg.kind : PROVIDERS[cfg.provider]?.kind || 'openai';
}

function headersFor(cfg) {
    if (kindOf(cfg) === 'anthropic') {
        return { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': ANTHROPIC_VERSION };
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` };
    if (cfg.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/yogurt5633-hub/st-app';
        headers['X-Title'] = 'Korrektor';
    }
    return headers;
}

/** A readable reason from a provider's error answer. */
function reasonOf(status, data, text) {
    const raw = typeof data?.error?.message === 'string' ? data.error.message
        : typeof data?.error === 'string' ? data.error
            : typeof data?.message === 'string' ? data.message
                : String(text || '').slice(0, 200);
    if (status === 401 || status === 403) return `ключ не принят (${status})${raw ? `: ${raw}` : ''}`;
    if (status === 402) return `на ключе кончились деньги (402)${raw ? `: ${raw}` : ''}`;
    if (status === 404) return `модель или адрес не найдены (404)${raw ? `: ${raw}` : ''}`;
    if (status === 429) return `слишком много запросов или исчерпан лимит (429)${raw ? `: ${raw}` : ''}`;
    return `${status}${raw ? `: ${raw}` : ''}`;
}

async function call(cfg, method, urlPath, body, { timeout = 120000, signal = null, fetchImpl = globalThis.fetch } = {}) {
    const base = baseUrl(cfg);
    if (!base) throw httpError(400, 'Не указан адрес сервера ключа');
    const signals = [AbortSignal.timeout(timeout), signal].filter(Boolean);
    let res;
    try {
        res = await fetchImpl(`${base}${urlPath}`, {
            method,
            headers: headersFor(cfg),
            body: body ? JSON.stringify(body) : undefined,
            signal: signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signals[0],
        });
    } catch (error) {
        if (signal?.aborted) throw httpError(499, 'Остановлено');
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw httpError(504, `${PROVIDERS[cfg.provider]?.label || 'Сервер'} не ответил за ${Math.round(timeout / 1000)} с`);
        throw httpError(502, `Нет связи с ${base}: ${error.cause?.code || error.message}`);
    }
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = null;
    }
    if (!res.ok || data?.error) {
        throw httpError(res.ok ? 502 : (res.status === 401 || res.status === 403 ? 401 : 502), `Ключ для перевода: ${reasonOf(res.status, data, text)}`);
    }
    if (!data) throw httpError(502, 'Ключ для перевода: сервер ответил не JSON — проверьте адрес');
    return data;
}

/** A request read as it comes (server-sent events); a provider that answers in one piece is read as usual. */
async function streamCall(cfg, urlPath, body, onDelta, { timeout = 300000, signal = null, fetchImpl = globalThis.fetch } = {}) {
    const base = baseUrl(cfg);
    if (!base) throw httpError(400, 'Не указан адрес сервера ключа');
    const signals = [AbortSignal.timeout(timeout), signal].filter(Boolean);
    let res;
    try {
        res = await fetchImpl(`${base}${urlPath}`, {
            method: 'POST',
            headers: { ...headersFor(cfg), Accept: 'text/event-stream' },
            body: JSON.stringify({ ...body, stream: true }),
            signal: signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signals[0],
        });
    } catch (error) {
        if (signal?.aborted) throw httpError(499, 'Остановлено');
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw httpError(504, `${PROVIDERS[cfg.provider]?.label || 'Сервер'} не ответил за ${Math.round(timeout / 1000)} с`);
        throw httpError(502, `Нет связи с ${base}: ${error.cause?.code || error.message}`);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let data = null;
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
        throw httpError(res.status === 401 || res.status === 403 ? 401 : 502, `Ключ для перевода: ${reasonOf(res.status, data, text)}`);
    }
    let text = '';
    let finish = null;
    let failure = '';
    let plain = '';
    const parser = sseParser((json) => {
        const delta = streamDelta(json);
        if (delta.error) failure = delta.error;
        if (delta.text) {
            text += delta.text;
            onDelta?.(text);
        }
        if (delta.finish) finish = delta.finish;
    });
    const decoder = new TextDecoder();
    try {
        for await (const chunk of res.body) {
            const piece = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            if (!parser.events && plain.length < 2_000_000) plain += piece;
            parser.push(piece);
        }
    } catch (error) {
        if (signal?.aborted) throw httpError(499, 'Остановлено');
        throw httpError(502, `Ключ для перевода: ответ оборвался (${error.message})`);
    }
    parser.end();
    if (failure) throw httpError(502, `Ключ для перевода: ${failure}`);
    if (!parser.events) {
        let data = null;
        try {
            data = JSON.parse(plain);
        } catch {
            throw httpError(502, 'Ключ для перевода: сервер ответил не так, как ожидалось — проверьте адрес');
        }
        return { data, text: '', finish: null, plain: true };
    }
    return { data: null, text, finish, plain: false };
}

// Claude models that take output_config.effort (older ones reject it).
const CLAUDE_EFFORT = /claude-(opus-4-[5-9]|sonnet-4-6|opus-5|sonnet-5|haiku-5|fable|mythos)/;
const OPENAI_REASONING = /(^|\/)(gpt-5|o[1-9])/;

/**
 * One request with the translator's key. Returns { text, cut, model, usage }:
 * cut = the answer stopped at the length limit (the end of the translation is missing).
 */
export async function completeWithKey(cfg, { system, user, maxTokens = 4096, signal = null, fetchImpl, strip = true, onDelta = null } = {}) {
    if (!cfg?.key) throw httpError(400, 'Ключ для перевода не сохранён');
    if (!cfg.model) throw httpError(400, 'Укажите модель для ключа перевода');
    const timeout = Math.min(300000, 60000 + String(user || '').length * 40);
    if (kindOf(cfg) === 'anthropic') {
        const body = { model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
        // Translation needs little thinking: faster and cheaper.
        if (CLAUDE_EFFORT.test(cfg.model)) body.output_config = { effort: 'low' };
        if (onDelta) {
            const streamed = await streamCall(cfg, '/messages', body, onDelta, { timeout, signal, fetchImpl });
            if (!streamed.plain) {
                return { text: strip ? stripThinking(streamed.text) : streamed.text.trim(), cut: CUT_REASONS.has(streamed.finish), model: cfg.model, usage: null };
            }
        }
        const data = await call(cfg, 'POST', '/messages', body, { timeout, signal, fetchImpl });
        if (data.stop_reason === 'refusal') throw httpError(502, 'Модель отказалась переводить этот текст');
        const text = (data.content || []).filter(b => b?.type === 'text').map(b => b.text).join('');
        return {
            text: strip ? stripThinking(text) : text.trim(),
            cut: data.stop_reason === 'max_tokens',
            model: data.model || cfg.model,
            usage: { input: Number(data.usage?.input_tokens) || 0, output: Number(data.usage?.output_tokens) || 0 },
        };
    }
    const body = { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false };
    if (OPENAI_REASONING.test(cfg.model) && (cfg.provider === 'openai' || cfg.provider === 'openrouter')) {
        body.max_completion_tokens = maxTokens;
        if (cfg.provider === 'openai') body.reasoning_effort = 'low';
    } else {
        body.max_tokens = maxTokens;
    }
    if (cfg.provider === 'openrouter') body.reasoning = { effort: 'low', exclude: true };
    if (onDelta) {
        const streamed = await streamCall(cfg, '/chat/completions', body, onDelta, { timeout, signal, fetchImpl });
        if (!streamed.plain) {
            return { text: strip ? stripThinking(streamed.text) : streamed.text.trim(), cut: CUT_REASONS.has(streamed.finish), model: cfg.model, usage: null };
        }
        // A server that ignores «stream»: its whole answer is in streamed.data.
        return fromChat(streamed.data, cfg, strip, onDelta);
    }
    const data = await call(cfg, 'POST', '/chat/completions', body, { timeout, signal, fetchImpl });
    return fromChat(data, cfg, strip);
}

/** An OpenAI-style answer in one piece. */
function fromChat(data, cfg, strip, onDelta = null) {
    const choice = data?.choices?.[0] || {};
    const content = choice.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('') : String(choice.text || '');
    onDelta?.(text);
    return {
        text: strip ? stripThinking(text) : text.trim(),
        cut: choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens',
        model: data?.model || cfg.model,
        usage: { input: Number(data?.usage?.prompt_tokens) || 0, output: Number(data?.usage?.completion_tokens) || 0 },
    };
}

/** Model ids the key can use (empty when the provider has no list). */
export async function listKeyModels(cfg, { fetchImpl } = {}) {
    if (!cfg?.key) return [];
    const data = await call(cfg, 'GET', '/models', null, { timeout: 30000, fetchImpl });
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
    return [...new Set(list.map(m => (typeof m === 'string' ? m : m?.id || m?.name || '')).map(id => String(id).replace(/^models\//, '')).filter(Boolean))].slice(0, 2000);
}

/**
 * «Проверить»: the model list (when there is one) and a tiny translation.
 * Returns { ok, ms, models, sample, message }.
 */
export async function checkKey(cfg, { fetchImpl } = {}) {
    if (!cfg?.key) return { ok: false, message: 'Сначала вставьте ключ' };
    let models = [];
    let listError = '';
    try {
        models = await listKeyModels(cfg, { fetchImpl });
    } catch (error) {
        // A wrong key is clear from here already; other providers simply have no list.
        if (error.status === 401) return { ok: false, message: error.message, models: [] };
        listError = error.message;
    }
    if (!cfg.model) {
        return models.length
            ? { ok: null, models, message: `Ключ принят, доступно моделей: ${models.length}. Выберите модель и проверьте ещё раз` }
            : { ok: false, models, message: listError || 'Укажите модель' };
    }
    const started = Date.now();
    try {
        const out = await completeWithKey(cfg, {
            system: 'Переведи текст пользователя на русский язык. Ответь только переводом.',
            user: 'The tavern was quiet tonight.',
            maxTokens: 400,
            fetchImpl,
        });
        const ms = Date.now() - started;
        if (!out.text.trim()) return { ok: false, ms, models, message: 'Модель ответила пустым текстом' };
        return { ok: true, ms, models, sample: out.text.trim().slice(0, 120), model: out.model, message: `Работает: ответ за ${(ms / 1000).toFixed(1)} с — «${out.text.trim().slice(0, 80)}»` };
    } catch (error) {
        return { ok: false, ms: Date.now() - started, models, message: error.message };
    }
}
