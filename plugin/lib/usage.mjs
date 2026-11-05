import path from 'node:path';
import { readJson, writeJson, withLock } from './util.mjs';

// How many tokens went where: the roleplay itself (numbers the companion
// extension sends after each reply) and Korrektor's own model calls.
// Kept per day, model and chat, for 60 days. Money is shown only for models
// with a known price: OpenRouter publishes its prices, others can be typed in.

const KEEP_DAYS = 60;
const PRICE_TTL_MS = 12 * 60 * 60 * 1000;
let openRouterPrices = { at: 0, items: {} };

function usageFile(store) {
    return path.join(store.dir, 'usage.json');
}

export function dayOf(date = new Date()) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * entry: { kind: 'roleplay' | 'korrektor', model, chatId, input, output, task }
 */
export async function logUsage(store, entry, now = new Date()) {
    const input = Math.max(0, Math.round(Number(entry.input) || 0));
    const output = Math.max(0, Math.round(Number(entry.output) || 0));
    if (!input && !output) return;
    const kind = entry.kind === 'korrektor' ? 'korrektor' : 'roleplay';
    const model = String(entry.model || 'неизвестная модель').slice(0, 120);
    const chatId = String(entry.chatId || '').slice(0, 300);
    const day = dayOf(now);
    await withLock(`${store.dir}:usage`, async () => {
        const data = await readJson(usageFile(store), { days: {} });
        data.days = data.days || {};
        const bucket = data.days[day] = data.days[day] || {};
        const key = `${kind}|${model}|${chatId}`;
        const row = bucket[key] = bucket[key] || { kind, model, chatId, input: 0, output: 0, calls: 0 };
        row.input += input;
        row.output += output;
        row.calls += 1;
        // The size of the latest request per chat: shows which chats became expensive.
        if (kind === 'roleplay' && chatId) {
            data.lastPrompt = data.lastPrompt || {};
            data.lastPrompt[chatId] = { tokens: input, model, at: now.toISOString() };
        }
        const cutoff = dayOf(new Date(now.getTime() - KEEP_DAYS * 86400000));
        for (const d of Object.keys(data.days)) if (d < cutoff) delete data.days[d];
        await writeJson(usageFile(store), data);
    });
}

/** Prices per 1M tokens: what the user typed, else OpenRouter's public list. */
export function priceFor(model, prices = {}, fetched = openRouterPrices.items) {
    const own = prices[model];
    if (own && (Number(own.input) > 0 || Number(own.output) > 0)) return { input: Number(own.input) || 0, output: Number(own.output) || 0, from: 'вы' };
    const or = fetched[model] || fetched[String(model).replace(/^openrouter\//, '')];
    if (or) return { ...or, from: 'OpenRouter' };
    return null;
}

export function cost(row, price) {
    if (!price) return null;
    return (row.input * price.input + row.output * price.output) / 1e6;
}

/** OpenRouter's price list is public: no key needed. Refreshed twice a day. */
export async function refreshOpenRouterPrices(fetchImpl = globalThis.fetch) {
    if (Date.now() - openRouterPrices.at < PRICE_TTL_MS || typeof fetchImpl !== 'function') return openRouterPrices.items;
    try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const items = {};
        for (const m of data?.data || []) {
            const input = Number(m?.pricing?.prompt) * 1e6;
            const output = Number(m?.pricing?.completion) * 1e6;
            if (m?.id && Number.isFinite(input) && Number.isFinite(output)) items[m.id] = { input, output };
        }
        openRouterPrices = { at: Date.now(), items };
    } catch {
        // offline or blocked: keep what we had, try again later
        openRouterPrices.at = Date.now() - PRICE_TTL_MS + 10 * 60 * 1000;
    }
    return openRouterPrices.items;
}

/**
 * Totals for the last `days` days: per day, per model, per chat, plus chats whose
 * latest request is large ("this chat became expensive").
 */
export async function usageSummary(store, { days = 7, prices = {}, expensiveTokens = 30000, fetched = openRouterPrices.items, now = new Date() } = {}) {
    const data = await readJson(usageFile(store), { days: {} });
    const from = dayOf(new Date(now.getTime() - (days - 1) * 86400000));
    const byDay = [];
    const byModel = new Map();
    const byChat = new Map();
    const total = { roleplay: { input: 0, output: 0, calls: 0, cost: 0 }, korrektor: { input: 0, output: 0, calls: 0, cost: 0 } };
    let unpriced = false;

    for (let i = days - 1; i >= 0; i--) {
        const day = dayOf(new Date(now.getTime() - i * 86400000));
        const rows = Object.values(data.days?.[day] || {});
        const sum = { day, roleplay: 0, korrektor: 0, cost: 0 };
        for (const row of rows) {
            const tokens = row.input + row.output;
            const price = priceFor(row.model, prices, fetched);
            const money = cost(row, price);
            if (money === null) unpriced = true;
            sum[row.kind] += tokens;
            sum.cost += money || 0;
            const t = total[row.kind];
            t.input += row.input;
            t.output += row.output;
            t.calls += row.calls;
            t.cost += money || 0;
            const m = byModel.get(row.model) || { model: row.model, input: 0, output: 0, calls: 0, cost: null, price };
            m.input += row.input;
            m.output += row.output;
            m.calls += row.calls;
            if (money !== null) m.cost = (m.cost || 0) + money;
            byModel.set(row.model, m);
            if (row.chatId) {
                const c = byChat.get(row.chatId) || { chatId: row.chatId, tokens: 0, calls: 0, cost: 0 };
                c.tokens += tokens;
                c.calls += row.calls;
                c.cost += money || 0;
                byChat.set(row.chatId, c);
            }
        }
        if (day >= from) byDay.push(sum);
    }

    const expensive = Object.entries(data.lastPrompt || {})
        .filter(([, v]) => v.tokens >= expensiveTokens)
        .map(([chatId, v]) => ({ chatId, tokens: v.tokens, model: v.model, at: v.at }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 10);

    return {
        days,
        byDay,
        total,
        models: [...byModel.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output)),
        chats: [...byChat.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 15),
        expensive,
        expensiveTokens,
        unpriced,
    };
}

/** Prices the user typed in, per 1M tokens: { model: { input, output } }. */
export async function getPrices(store) {
    const data = await readJson(usageFile(store), { days: {} });
    return data.prices || {};
}

export async function setPrice(store, model, input, output) {
    const name = String(model || '').slice(0, 120);
    if (!name) return getPrices(store);
    return withLock(`${store.dir}:usage`, async () => {
        const data = await readJson(usageFile(store), { days: {} });
        data.prices = data.prices || {};
        const i = Math.max(0, Number(input) || 0);
        const o = Math.max(0, Number(output) || 0);
        if (!i && !o) delete data.prices[name];
        else data.prices[name] = { input: i, output: o };
        await writeJson(usageFile(store), data);
        return data.prices;
    });
}

export async function lastPromptOf(store, chatId) {
    const data = await readJson(usageFile(store), { days: {} });
    return data.lastPrompt?.[chatId] ?? null;
}
