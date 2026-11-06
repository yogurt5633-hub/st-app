import http from 'node:http';
import https from 'node:https';
import { chatModelFor, connectionBody, connectionInfo, textgenInfo } from './st-settings.mjs';
import { httpError } from './util.mjs';
import { estimateTokens } from './tokens.mjs';
import { CUT_REASONS, sseParser, streamDelta } from './sse.mjs';

// Model calls go through SillyTavern's own endpoint
// /api/backends/chat-completions/generate on the loopback address.
// SillyTavern adds the API key on its side, so the key never reaches this plugin.

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const TEXT_GENERATE_PATH = '/api/backends/text-completions/generate';
const STATUS_PATH = '/api/backends/chat-completions/status';

// Claude is the recommendation, not a requirement: these are used only when the
// source is Claude and the user left the model field empty.
export const RECOMMENDED = {
    claude: { scan: 'claude-haiku-5-5', heavy: 'claude-opus-5-5' },
};
export const CLAUDE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5'];

const OPENAI_FAMILY = ['openai', 'azure_openai', 'openrouter'];
// OpenAI reasoning models take max_completion_tokens and reasoning_effort (same rule as SillyTavern's client).
function isOpenAiReasoning(source, model) {
    if (!OPENAI_FAMILY.includes(source)) return false;
    if (/gpt-5|gpt-6/.test(model)) return true;
    return source === 'openrouter' ? /^openai\/(o1|o3|o4)/.test(model) : /^(o1|o3|o4)/.test(model);
}
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// Claude models whose thinking SillyTavern controls with an effort level (adaptive thinking);
// the older ones think only when asked to, so for speed they are not asked.
const CLAUDE_ADAPTIVE = /^claude-(opus-4-[6-9]|sonnet-4-6|opus-5|sonnet-5|fable)/;

/**
 * 'fast' = as little thinking as the model allows (translation needs none): Gemini with no or the
 * smallest thinking budget, OpenAI reasoning models at low effort, Claude without thinking
 * where it can be off and at low effort where it cannot.
 */
export function fastEffort(source, model) {
    const id = String(model || '');
    if (source === 'claude') return CLAUDE_ADAPTIVE.test(id) ? 'low' : 'auto';
    if (source === 'makersuite' || source === 'vertexai') return 'min';
    if (isOpenAiReasoning(source, id)) return 'low';
    return 'auto';
}

/** The answer stopped at the length limit (OpenAI style or Claude style; SillyTavern passes these along for most sources). */
export function wasCut(data) {
    const reason = data?.choices?.[0]?.finish_reason ?? data?.stop_reason ?? data?.candidates?.[0]?.finishReason;
    return reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS';
}

/** Token counts from a provider reply: OpenAI style, Claude style or Gemini style. */
export function usageOf(data) {
    const u = data?.usage;
    if (u && (u.prompt_tokens || u.completion_tokens)) return { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 };
    if (u && (u.input_tokens || u.output_tokens)) {
        const input = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        return { input, output: Number(u.output_tokens) || 0 };
    }
    const g = data?.usageMetadata;
    if (g && (g.promptTokenCount || g.candidatesTokenCount)) return { input: Number(g.promptTokenCount) || 0, output: (Number(g.candidatesTokenCount) || 0) + (Number(g.thoughtsTokenCount) || 0) };
    return null;
}

/** Captures what is needed to call SillyTavern back as the same user. Kept in memory only. */
export function captureAuth(request) {
    const socket = request.socket;
    return {
        port: socket.localPort,
        tls: Boolean(socket.encrypted),
        cookie: request.headers.cookie || '',
        authorization: request.headers.authorization || '',
        csrf: request.headers['x-csrf-token'] || '',
        at: Date.now(),
    };
}

function postLoopback(auth, urlPath, body, host) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = auth.tls ? https : http;
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'Accept': 'application/json',
    };
    if (auth.cookie) headers.Cookie = auth.cookie;
    if (auth.authorization) headers.Authorization = auth.authorization;
    if (auth.csrf) headers['X-CSRF-Token'] = auth.csrf;

    return new Promise((resolve, reject) => {
        const req = transport.request({
            host,
            port: auth.port,
            path: urlPath,
            method: 'POST',
            headers,
            // Loopback to our own server: its certificate may be self-signed.
            rejectUnauthorized: false,
            timeout: REQUEST_TIMEOUT_MS,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Модель не ответила за 10 минут')));
        req.on('error', reject);
        req.end(payload);
    });
}

/** The same request, read as it comes: onChunk(text) for every piece of the answer. */
function streamLoopback(auth, urlPath, body, host, onChunk, signal) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = auth.tls ? https : http;
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'Accept': 'text/event-stream',
    };
    if (auth.cookie) headers.Cookie = auth.cookie;
    if (auth.authorization) headers.Authorization = auth.authorization;
    if (auth.csrf) headers['X-CSRF-Token'] = auth.csrf;
    return new Promise((resolve, reject) => {
        const req = transport.request({ host, port: auth.port, path: urlPath, method: 'POST', headers, rejectUnauthorized: false, timeout: REQUEST_TIMEOUT_MS }, res => {
            res.setEncoding('utf8');
            if (res.statusCode >= 400) {
                let text = '';
                res.on('data', chunk => { text += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, text }));
                res.on('error', reject);
                return;
            }
            res.on('data', chunk => onChunk(chunk));
            res.on('end', () => resolve({ status: res.statusCode, text: '' }));
            res.on('error', reject);
        });
        const onAbort = () => req.destroy(Object.assign(new Error('Остановлено'), { stopped: true }));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal?.removeEventListener('abort', onAbort));
        req.on('timeout', () => req.destroy(new Error('Модель не ответила за 10 минут')));
        req.on('error', reject);
        req.end(payload);
    });
}

async function streamToSillyTavern(auth, urlPath, body, onChunk, signal) {
    try {
        return await streamLoopback(auth, urlPath, body, '127.0.0.1', onChunk, signal);
    } catch (error) {
        if (error.code === 'ECONNREFUSED') return streamLoopback(auth, urlPath, body, '::1', onChunk, signal);
        throw error;
    }
}

async function postToSillyTavern(auth, urlPath, body) {
    try {
        return await postLoopback(auth, urlPath, body, '127.0.0.1');
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            return postLoopback(auth, urlPath, body, '::1');
        }
        throw error;
    }
}

/** Pulls plain text out of whatever shape the selected backend returned. */
export function extractText(data) {
    if (!data || typeof data !== 'object') return typeof data === 'string' ? data : '';
    // Claude through SillyTavern: original content blocks are passed along.
    if (Array.isArray(data.content)) {
        const text = data.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
        if (text) return text;
    }
    const message = data.choices?.[0]?.message;
    if (message) {
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
            return message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
        }
    }
    if (typeof data.choices?.[0]?.text === 'string') return data.choices[0].text;
    if (typeof data.text === 'string') return data.text;
    if (typeof data.output === 'string') return data.output;
    if (typeof data.content === 'string') return data.content; // llama.cpp
    if (typeof data.response === 'string') return data.response; // Ollama
    return '';
}

/** Reasoning models on some providers put their thoughts into the text. */
export function stripThinking(text) {
    return String(text ?? '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^[\s\S]*?<\/(think|thinking)>/i, '')
        .trim();
}

/** Builds a Text Completion prompt with the instruct template chosen in SillyTavern. */
export function instructPrompt(instruct, system, user) {
    if (!instruct?.enabled) {
        return { prompt: `${system}\n\n${user}\n\nОтвет:\n`, stop: [] };
    }
    const sep = instruct.wrap ? '\n' : '';
    const block = (prefix, text, suffix) => `${prefix || ''}${prefix ? sep : ''}${text}${suffix || sep}`;
    let prompt;
    if (instruct.system_same_as_user || !instruct.system_sequence) {
        prompt = block(instruct.input_sequence, `${system}\n\n${user}`, instruct.input_suffix);
    } else {
        prompt = block(instruct.system_sequence, system, instruct.system_suffix) + block(instruct.input_sequence, user, instruct.input_suffix);
    }
    const output = instruct.last_output_sequence || instruct.output_sequence || '';
    prompt += `${output}${output ? sep : ''}`;
    const stop = [instruct.stop_sequence, instruct.input_sequence, instruct.system_sequence]
        .map(x => String(x || '').trim())
        .filter(Boolean);
    return { prompt, stop: [...new Set(stop)] };
}

/** Finds the first JSON object or array in a model reply (fenced or bare). */
export function extractJson(text) {
    const value = String(text ?? '').trim();
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    candidates.push(value);
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // try the bracketed part
        }
        const starts = [candidate.indexOf('{'), candidate.indexOf('[')].filter(i => i >= 0);
        if (!starts.length) continue;
        const start = Math.min(...starts);
        const close = candidate[start] === '{' ? '}' : ']';
        const end = candidate.lastIndexOf(close);
        if (end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch {
                // keep looking
            }
        }
    }
    throw httpError(502, 'Модель ответила не в формате JSON');
}

export class LlmClient {
    /**
     * @param {object} options
     * @param {object} options.auth what captureAuth() returned
     * @param {object} options.settings plugin settings
     * @param {object} options.stSettings SillyTavern settings.json
     */
    constructor({ auth, settings, stSettings, onUsage = null }) {
        this.auth = auth;
        this.settings = settings;
        this.stSettings = stSettings;
        this.calls = 0;
        // Called with { model, input, output, task } after each answer, for the spending screen.
        this.onUsage = onUsage;
    }

    get available() {
        return Boolean(this.auth && this.auth.port);
    }

    /** Works out which API, source and model a task uses. */
    resolve(task) {
        // Translation may have a model of its own (chosen in the translation sheet or settings).
        const m = this.settings.models || {};
        if (task === 'translate' && (m.translateSource || (m.translate || '').trim())) return this.resolveTier('translate');
        return this.resolveTier(this.settings.tasks?.[task] === 'scan' ? 'scan' : 'heavy');
    }

    resolveTier(tier) {
        const conn = connectionInfo(this.stSettings);
        const models = this.settings.models;
        const chosenSource = models[`${tier}Source`] || '';
        const effort = models[`${tier}Effort`] || 'auto';
        const explicit = (models[tier] || '').trim();

        // "As in SillyTavern" with Text Completion selected there.
        if (!chosenSource && conn.api === 'text') {
            const text = textgenInfo(this.stSettings);
            return {
                api: 'text', tier, effort, source: text.type, model: explicit || text.model,
                why: explicit ? 'своя' : 'как в SillyTavern',
                maxTokens: Number(models[`${tier}MaxTokens`]) || (tier === 'scan' ? 2048 : 4096),
            };
        }

        const source = chosenSource || conn.source;
        let model = explicit;
        let why = 'своя';
        if (!model && RECOMMENDED[source]) {
            model = RECOMMENDED[source][tier];
            why = 'рекомендация';
        }
        if (!model) {
            model = chatModelFor(this.stSettings, source);
            why = 'как в SillyTavern';
        }
        const autoMax = source === 'claude' ? (tier === 'scan' ? 6000 : 16000) : (tier === 'scan' ? 4096 : 8192);
        return { api: 'chat', tier, effort, source, model, why, maxTokens: Number(models[`${tier}MaxTokens`]) || autoMax };
    }

    chatBody(r, system, user, messages = null) {
        const body = {
            chat_completion_source: r.source,
            model: r.model,
            messages: [
                { role: 'system', content: system },
                ...(messages ?? [{ role: 'user', content: user }]),
            ],
            max_tokens: r.maxTokens,
            stream: false,
            ...connectionBody(this.stSettings, r.source),
        };
        const effort = r.effort === 'fast' ? fastEffort(r.source, r.model) : r.effort;
        if (isOpenAiReasoning(r.source, r.model)) {
            body.max_completion_tokens = body.max_tokens;
            delete body.max_tokens;
            if (effort !== 'auto') body.reasoning_effort = effort;
        } else if (r.source === 'claude' && effort !== 'auto') {
            body.reasoning_effort = effort;
        } else if ((r.source === 'makersuite' || r.source === 'vertexai') && r.effort === 'fast') {
            body.reasoning_effort = effort;
        }
        return body;
    }

    textBody(r, system, user, messages = null) {
        const text = textgenInfo(this.stSettings);
        if (!text.server) throw httpError(400, 'В SillyTavern не указан адрес сервера Text Completion');
        // Text Completion has no turns: a multi-step talk is written out as one request.
        const flat = messages
            ? messages.map(m => `${m.role === 'assistant' ? '### Твой прошлый ответ' : '### Сообщение'}\n${m.content}`).join('\n\n')
            : user;
        const { prompt, stop } = instructPrompt(this.stSettings?.power_user?.instruct, system, flat);
        const max = r.maxTokens;
        return {
            api_type: text.type,
            api_server: text.server,
            prompt,
            model: r.model || undefined,
            max_new_tokens: max,
            max_tokens: max,
            n_predict: max,
            num_predict: max,
            stop,
            stopping_strings: stop,
            stream: false,
        };
    }

    /**
     * One request, one answer. Sampling parameters are left out on purpose:
     * the provider's defaults are fine for analysis, and current Claude models
     * reject non-default temperature/top_p/top_k.
     */
    async complete({ task, system, user, messages = null, maxTokens, effort = null, strip = true }) {
        if (!this.available) {
            throw httpError(409, 'Нет связи с сессией SillyTavern. Откройте приложение, чтобы проверка с моделью заработала');
        }
        const conn = connectionInfo(this.stSettings);
        const r = this.resolve(task);
        if (maxTokens) r.maxTokens = maxTokens;
        if (effort) r.effort = effort;
        if (r.api === 'chat' && !r.source) {
            throw httpError(400, conn.api === 'other'
                ? 'Этот тип API SillyTavern Корректор не поддерживает. Выберите источник модели в настройках Корректора'
                : 'В SillyTavern не выбран источник Chat Completion');
        }
        if (r.api === 'chat' && !r.model) throw httpError(400, 'Не задана модель для этой задачи. Укажите её в настройках');

        const path = r.api === 'text' ? TEXT_GENERATE_PATH : GENERATE_PATH;
        const body = r.api === 'text' ? this.textBody(r, system, user, messages) : this.chatBody(r, system, user, messages);
        const label = r.model || r.source;

        this.calls++;
        const res = await postToSillyTavern(this.auth, path, body);
        if (res.status === 403) {
            throw httpError(401, 'SillyTavern отклонил запрос: сессия устарела. Откройте приложение заново');
        }
        let data = null;
        try {
            data = JSON.parse(res.text);
        } catch {
            data = res.text;
        }
        if (res.status >= 400 || data?.error) {
            const message = typeof data?.error?.message === 'string' ? data.error.message
                : typeof data?.message === 'string' ? data.message
                    : typeof data === 'string' && data ? data.slice(0, 300)
                        : 'подробности в консоли SillyTavern';
            throw httpError(502, `Модель ${label} вернула ошибку: ${message}`);
        }
        const raw = extractText(data);
        // strip=false: the caller decides (a translated message may hold such tags itself).
        const text = strip ? stripThinking(raw) : String(raw ?? '').trim();
        if (!text) throw httpError(502, `Модель ${label} вернула пустой ответ`);
        if (this.onUsage) {
            const used = usageOf(data) ?? { input: estimateTokens(JSON.stringify(body.messages ?? body.prompt ?? '')), output: estimateTokens(raw) };
            try {
                await this.onUsage({ model: label, task, ...used });
            } catch {
                // the spending log must never break a model call
            }
        }
        return { text, model: label, source: r.source, tier: r.tier, cut: wasCut(data) };
    }

    /**
     * Like complete(), but the answer is read as the model writes it: onDelta(textSoFar) is
     * called as it grows. Text Completion is not streamed here: it comes whole, once.
     */
    async completeStream({ task, system, user, maxTokens, effort = null, strip = true, onDelta = null, signal = null }) {
        if (!this.available) {
            throw httpError(409, 'Нет связи с сессией SillyTavern. Откройте приложение, чтобы проверка с моделью заработала');
        }
        const r = this.resolve(task);
        if (r.api !== 'chat') {
            const out = await this.complete({ task, system, user, maxTokens, effort, strip });
            onDelta?.(out.text);
            return out;
        }
        if (maxTokens) r.maxTokens = maxTokens;
        if (effort) r.effort = effort;
        if (!r.source) throw httpError(400, 'В SillyTavern не выбран источник Chat Completion');
        if (!r.model) throw httpError(400, 'Не задана модель для этой задачи. Укажите её в настройках');
        const body = { ...this.chatBody(r, system, user), stream: true };
        const label = r.model || r.source;
        let text = '';
        let finish = null;
        let failure = '';
        // A proxy that ignores «stream» answers in one piece: kept to read it the usual way.
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
        this.calls++;
        const res = await streamToSillyTavern(this.auth, GENERATE_PATH, body, (chunk) => {
            if (!parser.events && plain.length < 2_000_000) plain += chunk;
            parser.push(chunk);
        }, signal);
        parser.end();
        if (res.status === 403) throw httpError(401, 'SillyTavern отклонил запрос: сессия устарела. Откройте приложение заново');
        if (res.status >= 400) {
            let data = null;
            try {
                data = JSON.parse(res.text);
            } catch {
                data = res.text;
            }
            const message = typeof data?.error?.message === 'string' ? data.error.message : typeof data?.message === 'string' ? data.message : typeof data === 'string' && data ? data.slice(0, 300) : 'подробности в консоли SillyTavern';
            throw httpError(502, `Модель ${label} вернула ошибку: ${message}`);
        }
        if (failure) throw httpError(502, `Модель ${label} вернула ошибку: ${failure}`);
        if (!parser.events) {
            let data = null;
            try {
                data = JSON.parse(plain);
            } catch {
                data = plain;
            }
            if (data?.error) throw httpError(502, `Модель ${label} вернула ошибку: ${data.error.message || data.error}`);
            text = extractText(data);
            if (wasCut(data)) finish = 'length';
            onDelta?.(text);
        }
        const out = strip ? stripThinking(text) : String(text).trim();
        if (!out) throw httpError(502, `Модель ${label} вернула пустой ответ`);
        if (this.onUsage) {
            try {
                await this.onUsage({ model: label, task, input: estimateTokens(JSON.stringify(body.messages)), output: estimateTokens(text) });
            } catch {
                // the spending log must never break a model call
            }
        }
        return { text: out, model: label, source: r.source, tier: r.tier, cut: CUT_REASONS.has(finish) };
    }

    async completeJson(options) {
        const result = await this.complete(options);
        return { ...result, json: extractJson(result.text) };
    }

    /** Model ids the provider offers, asked through SillyTavern with its key. */
    /**
     * Does SillyTavern's connection work? SillyTavern asks the provider for its
     * model list with its own key (the same check as its "Connect" button).
     * With test=true also sends a tiny request, for providers without a model list.
     */
    async checkConnection({ test = false } = {}) {
        const conn = connectionInfo(this.stSettings);
        const out = { api: conn.api, source: conn.source || conn.textType, model: conn.model || conn.textModel || '', ok: null, models: 0, message: '' };
        if (!this.available) return { ...out, ok: false, message: 'Нет связи с сессией SillyTavern: откройте приложение заново' };
        if (conn.api === 'chat' && conn.source && !test) {
            const res = await postToSillyTavern(this.auth, STATUS_PATH, { chat_completion_source: conn.source, ...connectionBody(this.stSettings, conn.source) });
            let data = null;
            try {
                data = JSON.parse(res.text);
            } catch {
                data = res.text;
            }
            const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.data?.data) ? data.data.data : Array.isArray(data) ? data : [];
            const reason = typeof data?.error?.message === 'string' ? data.error.message : typeof data?.message === 'string' ? data.message : '';
            if (list.length && !data?.error) return { ...out, ok: true, models: list.length, message: `Ключ работает, доступно моделей: ${list.length}` };
            // A clear refusal from the provider.
            if (reason || res.status === 401 || res.status === 403 || res.status >= 500) {
                return { ...out, ok: false, message: reason ? `Провайдер ответил: ${reason}` : 'Провайдер не принял ключ или не отвечает' };
            }
            // SillyTavern cannot list models for some providers (Claude among them) and answers
            // the same way as for a missing key: settle it with a tiny request instead.
        }
        if (conn.api === 'other') return { ...out, ok: null, message: 'Этот тип API Корректор проверить не может' };
        try {
            await this.complete({ task: 'facts', system: 'Ответь одним словом.', user: 'Скажи «да».', maxTokens: 64 });
            return { ...out, ok: true, tested: true, message: 'Пробный запрос прошёл: ключ и модель работают' };
        } catch (error) {
            return { ...out, ok: false, message: error.message };
        }
    }

    async listModels(source) {
        if (source === 'claude') return CLAUDE_MODELS;
        if (!this.available || !source) return [];
        const res = await postToSillyTavern(this.auth, STATUS_PATH, { chat_completion_source: source, ...connectionBody(this.stSettings, source) });
        let data = null;
        try {
            data = JSON.parse(res.text);
        } catch {
            return [];
        }
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.data?.data) ? data.data.data : Array.isArray(data) ? data : [];
        return [...new Set(list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean))].slice(0, 1000);
    }
}
