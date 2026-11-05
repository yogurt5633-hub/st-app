import fs from 'node:fs';
import path from 'node:path';
import { readJson, withLock, writeJson } from './util.mjs';

// Everything the plugin keeps lives in data/<user>/korrektor/.
// The API key never passes through here: model calls go through SillyTavern itself.

export const DEFAULT_SETTINGS = Object.freeze({
    models: {
        // Any AI whose key is saved in SillyTavern works.
        // Empty source = the API selected in SillyTavern right now.
        // Empty model = the model selected there; for Claude the recommended
        // pair is used instead (Haiku 5.5 for scans, Opus 5.5 for fixes).
        scanSource: '',
        heavySource: '',
        scan: '',
        heavy: '',
        scanEffort: 'low',
        heavyEffort: 'medium',
        // 0 = automatic
        scanMaxTokens: 0,
        heavyMaxTokens: 0,
    },
    // Which model handles which task: 'scan' (cheap) or 'heavy'.
    tasks: {
        facts: 'scan',
        contradictions: 'scan',
        fixContradiction: 'heavy',
        rewriteMessage: 'heavy',
        summary: 'heavy',
        condenseCard: 'heavy',
        condenseEntry: 'heavy',
        condensePrompt: 'heavy',
    },
    scan: {
        auto: true,
        intervalMinutes: 20,
        // 'recent' = the latest changed chats, 'watched' = only chats marked in the app
        mode: 'recent',
        watched: [],
        recentChats: 3,
        useModel: true,
        maxMessagesPerLlmScan: 40,
    },
    analyzers: {
        context: true,
        repetition: true,
        slop: true,
        facts: true,
        contradictions: true,
        loreDuplicates: true,
        loreKeys: true,
        bloat: true,
        tokens: true,
    },
    thresholds: {
        contextWarn: 0.8,
        cardTokens: 1800,
        entryTokens: 600,
        repeatMinMessages: 3,
        presetPromptTokens: 600,
    },
    summary: {
        // 'memory' = Summarize extension, 'note' = Author's Note, 'lorebook' = chat lorebook entry
        target: 'memory',
        hideSummarized: true,
        keepRecent: 30,
    },
    facts: {
        // '' = chat lorebook if any, else the character's lorebook, else a new one
        targetWorld: '',
    },
    notify: {
        termux: true,
    },
});

function merge(base, extra) {
    const out = structuredClone(base);
    for (const [key, value] of Object.entries(extra || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object') {
            out[key] = merge(out[key], value);
        } else if (key in out) {
            out[key] = value;
        }
    }
    return out;
}

export class Store {
    constructor(ctx) {
        this.ctx = ctx;
        this.dir = path.join(ctx.dirs.root, 'korrektor');
        this.files = {
            settings: path.join(this.dir, 'settings.json'),
            proposals: path.join(this.dir, 'proposals.json'),
            state: path.join(this.dir, 'state.json'),
        };
        this.backupsDir = path.join(this.dir, 'backups');
    }

    lock(name, fn) {
        return withLock(`${this.dir}:${name}`, fn);
    }

    async getSettings() {
        return merge(DEFAULT_SETTINGS, await readJson(this.files.settings, {}));
    }

    async saveSettings(patch) {
        return this.lock('settings', async () => {
            const current = await this.getSettings();
            const next = merge(current, patch);
            await writeJson(this.files.settings, next);
            return next;
        });
    }

    async getProposals() {
        const data = await readJson(this.files.proposals, { items: [] });
        return Array.isArray(data.items) ? data.items : [];
    }

    /** Runs fn(items) under a lock and saves the result. */
    async updateProposals(fn) {
        return this.lock('proposals', async () => {
            const items = await this.getProposals();
            const result = await fn(items);
            // Keep the file small: drop old closed items beyond 500.
            const closed = items.filter(p => !['open', 'needs_fix', 'preparing'].includes(p.status));
            if (closed.length > 500) {
                const drop = new Set(closed.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1)).slice(0, closed.length - 500).map(p => p.id));
                const kept = items.filter(p => !drop.has(p.id));
                items.length = 0;
                items.push(...kept);
            }
            await writeJson(this.files.proposals, { items });
            return result;
        });
    }

    async getState() {
        return readJson(this.files.state, { chats: {}, lastScan: null });
    }

    async updateState(fn) {
        return this.lock('state', async () => {
            const state = await this.getState();
            const result = await fn(state);
            await writeJson(this.files.state, state);
            return result;
        });
    }

    backupPath(id) {
        return path.join(this.backupsDir, id);
    }

    async ensureDir() {
        await fs.promises.mkdir(this.dir, { recursive: true });
    }
}
