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
import {
    addProposals, applyProposal, listProposals, makeProposal, prepareProposal,
    rejectProposal, revertProposal, fingerprint, OPEN_STATUSES,
} from './lib/proposals.mjs';
import { httpError, isInside, nowIso } from './lib/util.mjs';

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
            user: user.ctx.handle,
            connection: connectionInfo(stSettings),
            models: { scan: llm.resolveTier('scan'), heavy: llm.resolveTier('heavy') },
            open: proposals.filter(p => OPEN_STATUSES.includes(p.status)).length,
            lastScan: state.lastScan ?? null,
            scanning: publicJob(runningJob(user.ctx.handle, 'scan')),
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
    router.post('/proposals/:id/reject', route(async (req, user) => rejectProposal(user.store, req.params.id)));
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
            chatWorld: cc.chatWorld,
            note: { prompt: meta.note_prompt ?? '', interval: meta.note_interval ?? null, depth: meta.note_depth ?? null },
            summary: latestMemory(cc.chat),
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
