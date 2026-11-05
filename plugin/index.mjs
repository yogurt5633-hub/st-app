import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './lib/store.mjs';
import { LlmClient, captureAuth } from './lib/llm.mjs';
import { listChats, readChat } from './lib/chats.mjs';
import { listCards, readCard, cardName, getCardField, CARD_FIELDS } from './lib/cards.mjs';
import { listWorlds, readWorld, entriesOf } from './lib/worlds.mjs';
import { readStSettings, connectionInfo } from './lib/st-settings.mjs';
import { buildChatContext, latestMemory } from './lib/chat-context.mjs';
import { contextUsage } from './lib/analyzers/context.mjs';
import { FIXERS } from './lib/analyzers/fixers.mjs';
import { runScan } from './lib/scanner.mjs';
import { startJob, getJob, runningJob, publicJob } from './lib/jobs.mjs';
import { notifyTermux, termuxAvailable } from './lib/notify.mjs';
import { readBackup, restoreBackup, describeOp } from './lib/ops.mjs';
import { touchedSince } from './lib/touched.mjs';
import { cleanReport, reportItems } from './lib/actual.mjs';
import { runAsk } from './lib/ask.mjs';
import {
    addProposals, applyProposal, listProposals, makeProposal, prepareProposal,
    rejectProposal, revertProposal, fingerprint, OPEN_STATUSES,
} from './lib/proposals.mjs';
import { httpError, isInside, nowIso } from './lib/util.mjs';
import { logUsage, usageSummary, refreshOpenRouterPrices, getPrices, setPrice, lastPromptOf } from './lib/usage.mjs';
import { cardHealth } from './lib/health.mjs';
import { makeRecap } from './lib/recap.mjs';
import { noteRejection, setMuted } from './lib/mute.mjs';
import { collectFiles, summarize, writeZip, writeZipFile, describeArchive, restoreArchive, saveUpload } from './lib/archive.mjs';
import { loadCatalog, installItem } from './lib/catalog.mjs';
import { markTouched } from './lib/touched.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, 'app');
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const ID = 'korrektor';
const APP_PATH = `/api/plugins/${ID}/app/`;

export const info = {
    id: ID,
    name: 'Корректор',
    description: 'ИИ-ассистент: находит проблемы в чатах, лорбуках и карточках и правит их после подтверждения. Приложение: /api/plugins/korrektor/app/',
};

/** Users seen by the plugin. auth lives in memory only and is used to call SillyTavern back for model requests. */
const users = new Map();
let timer = null;

function registerUser(handle, dirs) {
    let user = users.get(handle);
    if (!user) {
        const ctx = { handle, dirs };
        user = { ctx, store: new Store(ctx), auth: null, lastAuto: 0 };
        users.set(handle, user);
    } else {
        user.ctx.dirs = dirs;
    }
    return user;
}

function userFrom(req) {
    if (!req.user?.directories) throw httpError(401, 'SillyTavern не передал пользователя. Войдите в SillyTavern');
    const handle = req.user.profile?.handle ?? 'default-user';
    const user = registerUser(handle, req.user.directories);
    // Remember the session only from the app's own calls.
    if (req.headers['x-korrektor'] && req.headers['x-csrf-token']) {
        user.auth = captureAuth(req);
    }
    return user;
}

function route(fn) {
    return async (req, res) => {
        try {
            const user = userFrom(req);
            await user.store.ensureDir();
            const out = await fn(req, user, res);
            if (!res.headersSent) res.json(out ?? { ok: true });
        } catch (error) {
            const status = Number(error.status) || 500;
            if (status >= 500) console.error('[korrektor]', error);
            if (!res.headersSent) {
                res.status(status).json({ error: error.message, problems: error.problems, canForce: error.canForce });
            }
        }
    };
}

async function llmFor(user) {
    return new LlmClient({
        auth: user.auth,
        settings: await user.store.getSettings(),
        stSettings: await readStSettings(user.ctx),
        // Korrektor's own model calls go to the spending screen.
        onUsage: (u) => logUsage(user.store, { kind: 'korrektor', model: u.model, input: u.input, output: u.output, task: u.task }),
    });
}

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

function serveApp(req, res) {
    const rel = req.params[0] || 'index.html';
    const file = path.join(APP_DIR, rel);
    if (!isInside(APP_DIR, file)) return res.sendStatus(404);
    fs.readFile(file, (error, data) => {
        if (error) return res.sendStatus(404);
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        if (rel === 'sw.js') res.setHeader('Service-Worker-Allowed', APP_PATH);
        res.end(data);
    });
}

const nameCache = new Map();
async function characterName(ctx, avatar) {
    let mtime = 0;
    try {
        mtime = (await fs.promises.stat(path.join(ctx.dirs.characters, avatar))).mtimeMs;
    } catch {
        return avatar.replace(/\.png$/i, '');
    }
    const key = `${ctx.handle}:${avatar}:${mtime}`;
    if (!nameCache.has(key)) {
        try {
            const { card } = await readCard(ctx, avatar);
            nameCache.set(key, cardName(card, avatar.replace(/\.png$/i, '')));
        } catch {
            nameCache.set(key, avatar.replace(/\.png$/i, ''));
        }
    }
    return nameCache.get(key);
}

function scanJob(user, { chatIds = null, useModel = true, background = false } = {}) {
    const existing = runningJob(user.ctx.handle, 'scan');
    if (existing) return existing;
    return startJob(user.ctx.handle, 'scan', async (log) => {
        const llm = useModel ? await llmFor(user) : null;
        const result = await runScan(user.ctx, user.store, { chatIds, llm, background, log });
        const settings = await user.store.getSettings();
        if (background && result.added > 0 && settings.notify.termux) {
            const port = user.auth?.port;
            notifyTermux({
                title: 'Корректор',
                content: `Новых предложений: ${result.added}. Откройте приложение, чтобы посмотреть`,
                url: port ? `http://127.0.0.1:${port}${APP_PATH}` : null,
            });
        }
        return result;
    }, { background });
}

function prepareJob(user, id) {
    const existing = runningJob(user.ctx.handle, 'prepare', meta => meta.id === id);
    if (existing) return existing;
    return startJob(user.ctx.handle, 'prepare', async () => {
        const llm = await llmFor(user);
        const deps = { llm, settings: await user.store.getSettings(), stSettings: await readStSettings(user.ctx) };
        return prepareProposal(user.ctx, user.store, id, FIXERS, deps);
    }, { id });
}

async function tick() {
    for (const user of users.values()) {
        try {
            const settings = await user.store.getSettings();
            if (!settings.scan.auto) continue;
            const interval = Math.max(5, Number(settings.scan.intervalMinutes) || 20) * 60000;
            if (Date.now() - user.lastAuto < interval) continue;
            user.lastAuto = Date.now();
            scanJob(user, { background: true, useModel: Boolean(user.auth) });
        } catch (error) {
            console.warn('[korrektor] background scan failed:', error.message);
        }
    }
}

/** After a restart, pick up users who already used the app, so background checks resume. */
function discoverUsers() {
    const root = globalThis.DATA_ROOT;
    if (!root || !fs.existsSync(root)) return;
    const template = { root: '', worlds: 'worlds', groups: 'groups', groupChats: 'group chats', chats: 'chats', characters: 'characters', backups: 'backups', openAI_Settings: 'OpenAI Settings' };
    for (const handle of fs.readdirSync(root)) {
        const base = path.join(root, handle);
        if (!fs.existsSync(path.join(base, 'korrektor'))) continue;
        const dirs = Object.fromEntries(Object.entries(template).map(([k, v]) => [k, path.join(base, v)]));
        const user = registerUser(handle, dirs);
        // Let the first background pass happen a few minutes after start, not during startup.
        user.lastAuto = Date.now();
    }
}

export async function init(router) {
    router.get('/', (req, res) => res.redirect(`${req.baseUrl}/app/`));
    // '/app/*' first: Express matches '/app' with a trailing slash too, which would loop.
    router.get('/app/*', serveApp);
    router.get('/app', (req, res) => res.redirect(`${req.baseUrl}/app/`));

    router.get('/status', route(async (req, user) => {
        const settings = await user.store.getSettings();
        const stSettings = await readStSettings(user.ctx);
        const state = await user.store.getState();
        const proposals = await user.store.getProposals();
        const llm = new LlmClient({ auth: user.auth, settings, stSettings });
        return {
            version: VERSION,
            // Where SillyTavern loaded the plugin from: shows which folder the installer must update.
            pluginDir: HERE,
            user: user.ctx.handle,
            connection: connectionInfo(stSettings),
            models: { scan: llm.resolveTier('scan'), heavy: llm.resolveTier('heavy') },
            open: proposals.filter(p => OPEN_STATUSES.includes(p.status)).length,
            lastScan: state.lastScan ?? null,
            scanning: publicJob(runningJob(user.ctx.handle, 'scan')),
            connectionCheck: user.connectionCheck ?? null,
            termux: termuxAvailable(),
            time: nowIso(),
        };
    }));

    // Models the provider offers, fetched by SillyTavern with its own key.
    router.get('/models', route(async (req, user) => {
        const llm = await llmFor(user);
        const conn = connectionInfo(llm.stSettings);
        if (!req.query.source && conn.api === 'text') return { source: conn.textType, items: conn.textModel ? [conn.textModel] : [] };
        const source = String(req.query.source || '') || conn.source;
        return { source, items: await llm.listModels(source) };
    }));

    router.get('/settings', route(async (req, user) => user.store.getSettings()));
    router.post('/settings', route(async (req, user) => user.store.saveSettings(req.body || {})));

    router.get('/proposals', route(async (req, user) => ({ items: await listProposals(user.store, { status: req.query.status }) })));
    router.get('/proposals/:id', route(async (req, user) => {
        const item = (await user.store.getProposals()).find(p => p.id === req.params.id);
        if (!item) throw httpError(404, 'Предложение не найдено');
        return item;
    }));
    router.post('/proposals/:id/apply', route(async (req, user) => applyProposal(user.ctx, user.store, req.params.id, req.body?.overrides)));
    router.post('/proposals/:id/reject', route(async (req, user) => {
        const proposal = await rejectProposal(user.store, req.params.id);
        const learned = await noteRejection(user.store, proposal?.kind);
        return { ...proposal, suggestMute: learned.suggestMute, rejectedOfKind: learned.count };
    }));
    // Stop (or start again) showing one kind of findings.
    router.post('/mute', route(async (req, user) => {
        const kind = String(req.body?.kind || '');
        if (!kind) throw httpError(400, 'Нужен kind');
        return { muted: await setMuted(user.store, kind, req.body?.muted !== false) };
    }));
    router.post('/proposals/:id/revert', route(async (req, user) => revertProposal(user.ctx, user.store, req.params.id, { force: Boolean(req.body?.force) })));
    router.post('/proposals/:id/prepare', route(async (req, user) => publicJob(prepareJob(user, req.params.id))));
    router.post('/proposals/:id/followup', route(async (req, user) => {
        const parent = (await user.store.getProposals()).find(p => p.id === req.params.id);
        const followup = parent?.followups?.[Number(req.body?.index ?? 0)];
        if (!followup) throw httpError(404, 'Действие не найдено');
        const proposal = makeProposal({
            kind: 'rewrite',
            severity: parent.severity,
            title: followup.label,
            summary: `Модель перепишет сообщение #${followup.params.index}. Перед применением вы увидите разницу`,
            target: parent.target,
            fingerprint: fingerprint('followup', parent.id, req.body?.index ?? 0, Date.now()),
            prepare: { type: followup.type, ...followup.params },
        });
        await addProposals(user.store, [proposal]);
        return { proposal, job: publicJob(prepareJob(user, proposal.id)) };
    }));

    router.post('/scan', route(async (req, user) => {
        const chatIds = Array.isArray(req.body?.chatIds) ? req.body.chatIds.map(String) : null;
        user.lastAuto = Date.now();
        return publicJob(scanJob(user, { chatIds, useModel: req.body?.useModel !== false }));
    }));
    router.get('/jobs/:id', route(async (req, user) => {
        const job = getJob(req.params.id, user.ctx.handle);
        if (!job) throw httpError(404, 'Задача не найдена');
        return publicJob(job);
    }));

    // Read API: chats, characters, lorebooks, summaries and Author's Notes.
    router.get('/chats', route(async (req, user) => {
        const limit = Math.min(1000, Number(req.query.limit) || 300);
        const chats = (await listChats(user.ctx)).slice(0, limit);
        const state = await user.store.getState();
        const proposals = await user.store.getProposals();
        const settings = await user.store.getSettings();
        const watched = new Set(settings.scan.watched || []);
        const items = [];
        for (const chat of chats) {
            const title = chat.isGroup ? chat.title : await characterName(user.ctx, chat.avatar);
            items.push({
                ...chat,
                title,
                watched: watched.has(chat.id),
                scannedAt: state.chats?.[chat.id]?.scannedAt ?? null,
                open: proposals.filter(p => OPEN_STATUSES.includes(p.status) && (p.target?.chatId === chat.id || p.chats?.includes(chat.id))).length,
            });
        }
        return { items, mode: settings.scan.mode };
    }));
    // "Ask Korrektor": a request in plain words about one chat.
    router.post('/ask', route(async (req, user) => {
        const chatId = String(req.body?.chatId || '');
        const request = String(req.body?.request || '');
        if (!chatId) throw httpError(400, 'Нужен chatId');
        if (!request.trim()) throw httpError(400, 'Напишите, что нужно сделать');
        const job = startJob(user.ctx.handle, 'ask', async (log) => {
            const llm = await llmFor(user);
            return runAsk(user.ctx, user.store, { chatId, request, llm, stSettings: llm.stSettings, settings: llm.settings, log });
        }, { chatId });
        return publicJob(job);
    }));

    // Real numbers of the last request, sent by the companion extension after each reply.
    router.post('/actual', route(async (req, user) => {
        const report = cleanReport(req.body);
        await user.store.saveActual(report);
        // Each reply is also a request paid for: the spending screen counts it.
        await logUsage(user.store, { kind: 'roleplay', model: report.model, chatId: report.chatId, input: report.total, output: report.reply });
        return { ok: true };
    }));

    // ---------- spending ----------
    router.get('/usage', route(async (req, user) => {
        const settings = await user.store.getSettings();
        const prices = await getPrices(user.store);
        const fetched = await refreshOpenRouterPrices();
        const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
        const summary = await usageSummary(user.store, { days, prices, fetched, expensiveTokens: settings.thresholds.expensivePrompt });
        const chats = await listChats(user.ctx);
        for (const row of [...summary.chats, ...summary.expensive]) {
            const chat = chats.find(c => c.id === row.chatId);
            row.title = chat ? (chat.isGroup ? chat.title : await characterName(user.ctx, chat.avatar)) : row.chatId.split('/').pop();
        }
        return { ...summary, prices };
    }));
    router.post('/usage/price', route(async (req, user) => ({ prices: await setPrice(user.store, req.body?.model, req.body?.input, req.body?.output) })));

    // ---------- does the key work ----------
    router.post('/connection-check', route(async (req, user) => {
        const llm = await llmFor(user);
        const result = { ...(await llm.checkConnection({ test: Boolean(req.body?.test) })), at: nowIso() };
        user.connectionCheck = result;
        return result;
    }));

    // ---------- card health ----------
    router.get('/card-health', route(async (req, user) => {
        const avatar = String(req.query.avatar || '');
        const { card } = await readCard(user.ctx, avatar);
        const conn = connectionInfo(await readStSettings(user.ctx));
        return { name: cardName(card, avatar.replace(/\.png$/i, '')), ...cardHealth(card, avatar, { proposals: await user.store.getProposals(), contextSize: conn.contextSize }) };
    }));
    router.get('/cards-health', route(async (req, user) => {
        const conn = connectionInfo(await readStSettings(user.ctx));
        const proposals = await user.store.getProposals();
        const items = [];
        for (const entry of (await listCards(user.ctx)).slice(0, 300)) {
            try {
                const { card } = await readCard(user.ctx, entry.avatar);
                const health = cardHealth(card, entry.avatar, { proposals, contextSize: conn.contextSize });
                items.push({ avatar: entry.avatar, name: cardName(card, entry.avatar.replace(/\.png$/i, '')), score: health.score, verdict: health.verdict, tokens: health.tokens });
            } catch {
                // a broken PNG: skip
            }
        }
        return { items: items.sort((a, b) => a.score - b.score) };
    }));

    // ---------- session recap ----------
    router.post('/recap', route(async (req, user) => {
        const chatId = String(req.body?.chatId || '');
        if (!chatId) throw httpError(400, 'Нужен chatId');
        const job = startJob(user.ctx.handle, 'recap', async () => makeRecap(user.ctx, user.store, { chatId, llm: await llmFor(user) }), { chatId });
        return publicJob(job);
    }));

    // ---------- full backup of SillyTavern data ----------
    const uploads = path.join('korrektor', 'archives');
    router.get('/archive/info', route(async (req, user) => summarize(await collectFiles(user.ctx.dirs.root))));
    router.get('/archive', route(async (req, user, res) => {
        const files = await collectFiles(user.ctx.dirs.root);
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="sillytavern-${encodeURIComponent(user.ctx.handle)}-${stamp}.zip"`);
        res.setHeader('Cache-Control', 'no-store');
        await writeZip(res, files);
        res.end();
    }));
    router.post('/archive/upload', route(async (req, user) => {
        const id = `upload-${Date.now()}`;
        const file = path.join(user.ctx.dirs.root, uploads, `${id}.zip`);
        await saveUpload(req, file);
        try {
            return { upload: id, ...(await describeArchive(user.ctx.dirs.root, file)) };
        } catch (error) {
            await fs.promises.rm(file, { force: true });
            throw error;
        }
    }));
    router.post('/archive/restore', route(async (req, user) => {
        const id = String(req.body?.upload || '');
        if (!/^upload-\d+$/.test(id)) throw httpError(400, 'Неверный файл');
        const dir = path.join(user.ctx.dirs.root, uploads);
        const file = path.join(dir, `${id}.zip`);
        if (!fs.existsSync(file)) throw httpError(404, 'Загруженный файл не найден, загрузите его ещё раз');
        // Always a copy of the current state first: the restore can be undone with it.
        const safety = `before-restore-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
        await writeZipFile(path.join(dir, safety), await collectFiles(user.ctx.dirs.root));
        const result = await restoreArchive(user.ctx.dirs.root, file);
        await fs.promises.rm(file, { force: true });
        // Keep the three latest safety copies.
        const old = (await fs.promises.readdir(dir)).filter(n => n.startsWith('before-restore-')).sort().reverse().slice(3);
        for (const name of old) await fs.promises.rm(path.join(dir, name), { force: true });
        markTouched(user.ctx.handle, 'settings', 'restore');
        return { ...result, safety };
    }));
    router.get('/archive/safety', route(async (req, user) => {
        const dir = path.join(user.ctx.dirs.root, uploads);
        let names = [];
        try {
            names = (await fs.promises.readdir(dir)).filter(n => n.startsWith('before-restore-')).sort().reverse();
        } catch {
            names = [];
        }
        const items = [];
        for (const name of names) items.push({ name, bytes: (await fs.promises.stat(path.join(dir, name))).size });
        return { items };
    }));
    router.get('/archive/safety/:name', route(async (req, user, res) => {
        const name = String(req.params.name);
        if (!/^before-restore-[\d-]+\.zip$/.test(name)) throw httpError(400, 'Неверное имя');
        const file = path.join(user.ctx.dirs.root, uploads, name);
        if (!fs.existsSync(file)) throw httpError(404, 'Копия не найдена');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        await new Promise((resolve, reject) => fs.createReadStream(file).on('error', reject).on('end', resolve).pipe(res));
    }));

    // ---------- catalog ----------
    router.get('/catalog', route(async (req, user) => {
        const catalog = await loadCatalog({ force: Boolean(req.query.force) });
        return { items: catalog.items, error: catalog.error };
    }));
    router.post('/catalog/install', route(async (req, user) => {
        const catalog = await loadCatalog();
        const item = catalog.items.find(i => i.id === String(req.body?.id || ''));
        if (!item) throw httpError(404, 'Такой записи в каталоге нет');
        return installItem(user.ctx, item);
    }));

    // After the app imported something through SillyTavern itself: let the open tab refresh.
    router.post('/refresh', route(async (req, user) => {
        const type = ['card', 'world', 'settings'].includes(req.body?.type) ? req.body.type : 'card';
        markTouched(user.ctx.handle, type, String(req.body?.ref || ''));
        return { ok: true };
    }));

    // Mark a chat as watched (checked by the assistant) or not.
    router.post('/watch', route(async (req, user) => {
        const chatId = String(req.body?.chatId || '');
        if (!chatId) throw httpError(400, 'Нужен chatId');
        const settings = await user.store.getSettings();
        const set = new Set(settings.scan.watched || []);
        if (req.body?.watched === false) set.delete(chatId);
        else set.add(chatId);
        const next = await user.store.saveSettings({ scan: { watched: [...set] } });
        return { watched: next.scan.watched };
    }));

    router.get('/chat', route(async (req, user) => {
        const stSettings = await readStSettings(user.ctx);
        const cc = await buildChatContext(user.ctx, String(req.query.id), stSettings);
        const meta = cc.chat.header?.chat_metadata || {};
        const settings = await user.store.getSettings();
        const out = {
            id: cc.chatId,
            title: cc.title,
            watched: (settings.scan.watched || []).includes(cc.chatId),
            messages: cc.chat.messages.length,
            usage: contextUsage(cc),
            worlds: cc.worlds.map(w => w.name),
            charMemory: cc.charMemory?.installed ? {
                enabled: cc.charMemory.enabled,
                retrieval: cc.charMemory.retrieval,
                files: cc.charMemory.files.map(f => f.name),
                count: cc.charMemory.memories?.count ?? 0,
            } : null,
            chatWorld: cc.chatWorld,
            note: { prompt: meta.note_prompt ?? '', interval: meta.note_interval ?? null, depth: meta.note_depth ?? null },
            actual: await (async () => {
                const report = await user.store.getActual(cc.chatId);
                return report ? { ...report, items: reportItems(report) } : null;
            })(),
            summary: latestMemory(cc.chat),
            recap: (await user.store.getState()).chats?.[cc.chatId]?.recap ?? null,
            lastPrompt: await lastPromptOf(user.store, cc.chatId),
        };
        if (req.query.messages) {
            const from = Math.max(0, Number(req.query.from) || 0);
            out.items = cc.chat.messages.slice(from, from + 200).map((m, i) => ({
                index: from + i,
                name: m.name ?? '',
                isUser: Boolean(m.is_user),
                hidden: Boolean(m.is_system),
                text: m.mes ?? '',
                memory: m.extra?.memory ?? null,
            }));
        }
        return out;
    }));
    router.get('/cards', route(async (req, user) => ({ items: await listCards(user.ctx) })));
    router.get('/card', route(async (req, user) => {
        const { card } = await readCard(user.ctx, String(req.query.avatar));
        return { avatar: String(req.query.avatar), name: cardName(card), fields: Object.fromEntries(CARD_FIELDS.map(f => [f, getCardField(card, f)])), world: card?.data?.extensions?.world ?? '' };
    }));
    router.get('/worlds', route(async (req, user) => ({ items: await listWorlds(user.ctx) })));
    router.get('/world', route(async (req, user) => {
        const world = await readWorld(user.ctx, String(req.query.name));
        return { name: world.name, entries: entriesOf(world) };
    }));

    // Write API: any change becomes a card that waits for confirmation in the app.
    router.post('/changes', route(async (req, user) => {
        const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
        if (!ops.length) throw httpError(400, 'Нужен список ops');
        const target = req.body.target ?? (ops[0].chatId ? { type: 'chat', chatId: ops[0].chatId } : ops[0].world ? { type: 'world', world: ops[0].world } : { type: 'card', avatar: ops[0].avatar });
        const proposal = makeProposal({
            kind: 'manual',
            severity: 'low',
            title: String(req.body.title || 'Изменение по запросу'),
            summary: String(req.body.summary || 'Изменение пришло через API и ждёт вашего подтверждения'),
            target,
            fingerprint: fingerprint('manual', Date.now(), ops),
            ops,
            views: ops.map(op => describeOp(op)),
        });
        await addProposals(user.store, [proposal]);
        return proposal;
    }));

    // For the companion extension: which chats and cards changed since the given moment.
    router.get('/touched', route(async (req, user) => {
        const now = Date.now();
        const since = Number(req.query.since);
        return { now, items: Number.isFinite(since) && since > 0 ? touchedSince(user.ctx.handle, since) : [] };
    }));

    router.get('/backups', route(async (req, user) => {
        let names = [];
        try {
            names = await fs.promises.readdir(user.store.backupsDir);
        } catch {
            names = [];
        }
        const items = [];
        for (const name of names.sort().reverse().slice(0, 100)) {
            try {
                const { manifest } = await readBackup(user.store, name);
                items.push(manifest);
            } catch {
                // incomplete backup folder
            }
        }
        return { items };
    }));
    router.post('/backups/:id/restore', route(async (req, user) => restoreBackup(user.ctx, user.store, req.params.id)));

    discoverUsers();
    timer = setInterval(() => { tick().catch(() => { }); }, 60000);
    timer.unref?.();
    console.log(`[korrektor] ${VERSION} готов: откройте ${APP_PATH}`);
}

export async function exit() {
    if (timer) clearInterval(timer);
    timer = null;
}

export default { info, init, exit };
