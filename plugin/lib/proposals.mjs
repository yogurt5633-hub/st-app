import { applyOps, describeOp, inverseOps, restoreBackup, withOverrides } from './ops.mjs';
import { httpError, newId, nowIso, sha256 } from './util.mjs';

/*
 A proposal is one card in the app feed: a found problem plus the change that
 fixes it. Status flow:
   needs_fix -> preparing -> open      (a model writes the fix on request)
   open -> applied -> reverted
   open | needs_fix -> rejected
   open -> stale                       (the file changed, the fix no longer fits)
*/

export const OPEN_STATUSES = ['open', 'needs_fix', 'preparing'];

export function fingerprint(...parts) {
    return sha256(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join('|')).slice(0, 24);
}

export function makeProposal({ kind, severity = 'medium', title, summary, evidence = [], target, fingerprint: fp, ops = null, views = null, prepare = null, model = null, context = {}, followups = [], advice = false }) {
    const now = nowIso();
    return {
        id: newId('p'),
        kind,
        severity,
        title,
        summary,
        evidence,
        target,
        fingerprint: fp,
        // Advice has no change to apply: the card only explains what to do.
        status: advice || (ops && ops.length) ? 'open' : 'needs_fix',
        advice,
        ops: ops ?? [],
        views: views ?? (ops ?? []).map(op => describeOp(op, context)),
        prepare,
        followups,
        model,
        createdAt: now,
        updatedAt: now,
    };
}

/** Adds new proposals, skipping ones already known (open, applied or rejected). */
export async function addProposals(store, list) {
    if (!list.length) return [];
    return store.updateProposals(items => {
        const known = new Map(items.filter(p => p.status !== 'stale' && p.status !== 'failed').map(p => [p.fingerprint, p]));
        const added = [];
        for (const proposal of list) {
            const existing = known.get(proposal.fingerprint);
            if (existing) {
                // The same problem seen from another chat: remember that chat too.
                if (Array.isArray(proposal.chats) && proposal.chats.length) {
                    existing.chats = [...new Set([...(existing.chats || []), ...proposal.chats])];
                }
                continue;
            }
            items.push(proposal);
            known.set(proposal.fingerprint, proposal);
            added.push(proposal);
        }
        return added;
    });
}

async function findProposal(store, id) {
    const items = await store.getProposals();
    const proposal = items.find(p => p.id === id);
    if (!proposal) throw httpError(404, 'Предложение не найдено');
    return proposal;
}

async function patchProposal(store, id, patch) {
    return store.updateProposals(items => {
        const proposal = items.find(p => p.id === id);
        if (!proposal) throw httpError(404, 'Предложение не найдено');
        Object.assign(proposal, typeof patch === 'function' ? patch(proposal) : patch, { updatedAt: nowIso() });
        return proposal;
    });
}

export async function applyProposal(ctx, store, id, overrides) {
    const proposal = await findProposal(store, id);
    if (proposal.status !== 'open') throw httpError(409, 'Это предложение нельзя применить в текущем состоянии');
    if (proposal.advice || !proposal.ops?.length) throw httpError(409, 'Это совет: применять нечего');
    const ops = withOverrides(proposal.ops, overrides);
    try {
        const { backupId, appliedOps } = await applyOps(ctx, store, ops, { proposalId: id, title: proposal.title });
        return patchProposal(store, id, {
            status: 'applied',
            ops,
            views: ops.map((op, i) => ({ ...describeOp(op), label: proposal.views?.[i]?.label ?? describeOp(op).label })),
            edited: Boolean(overrides && Object.keys(overrides).length),
            appliedOps,
            backupId,
            appliedAt: nowIso(),
            error: null,
        });
    } catch (error) {
        if (error.status === 409) {
            await patchProposal(store, id, { status: 'stale', error: error.message });
        }
        throw error;
    }
}

export async function rejectProposal(store, id) {
    const proposal = await findProposal(store, id);
    if (!OPEN_STATUSES.includes(proposal.status) && proposal.status !== 'stale' && proposal.status !== 'failed') {
        throw httpError(409, 'Это предложение уже закрыто');
    }
    return patchProposal(store, id, { status: 'rejected', rejectedAt: nowIso() });
}

/**
 * Undo. First tries the precise way (inverse ops: only our change is undone,
 * newer messages stay). With force=true restores the whole files from backup.
 */
export async function revertProposal(ctx, store, id, { force = false } = {}) {
    const proposal = await findProposal(store, id);
    if (proposal.status !== 'applied') throw httpError(409, 'Откатить можно только применённое предложение');
    if (force) {
        const { safetyBackupId } = await restoreBackup(ctx, store, proposal.backupId);
        return patchProposal(store, id, { status: 'reverted', revertedAt: nowIso(), revertMode: 'backup', safetyBackupId });
    }
    try {
        const { backupId } = await applyOps(ctx, store, inverseOps(proposal.appliedOps), { proposalId: id, title: `Откат: ${proposal.title}` });
        return patchProposal(store, id, { status: 'reverted', revertedAt: nowIso(), revertMode: 'precise', revertBackupId: backupId });
    } catch (error) {
        if (error.status === 409) {
            throw httpError(409, `Точный откат невозможен: ${error.message}. Можно восстановить файлы из резервной копии целиком, но тогда пропадут изменения, сделанные после применения`, { canForce: true });
        }
        throw error;
    }
}

/** Fixers write the change for proposals created without one (needs_fix). */
export async function prepareProposal(ctx, store, id, fixers, deps) {
    const proposal = await findProposal(store, id);
    if (proposal.status !== 'needs_fix' && proposal.status !== 'failed') {
        throw httpError(409, 'Для этого предложения правка уже подготовлена');
    }
    const fixer = fixers[proposal.prepare?.type];
    if (!fixer) throw httpError(400, 'Для этого предложения нет автоматической правки');
    await patchProposal(store, id, { status: 'preparing', error: null });
    try {
        const result = await fixer(ctx, proposal, deps);
        return patchProposal(store, id, {
            status: 'open',
            ops: result.ops,
            views: result.views ?? result.ops.map(op => describeOp(op, result.context ?? {})),
            model: result.model ?? proposal.model,
            note: result.note ?? proposal.note ?? null,
        });
    } catch (error) {
        await patchProposal(store, id, { status: 'failed', error: error.message });
        throw error;
    }
}

export async function listProposals(store, { status } = {}) {
    const items = await store.getProposals();
    const filtered = status === 'open' ? items.filter(p => OPEN_STATUSES.includes(p.status) || p.status === 'stale' || p.status === 'failed')
        : status === 'closed' ? items.filter(p => ['applied', 'rejected', 'reverted'].includes(p.status))
            : items;
    return filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Marks open proposals for a target as stale when a rescan shows the problem is gone. */
export async function markResolved(store, targetKey, aliveFingerprints, kinds) {
    return store.updateProposals(items => {
        let count = 0;
        for (const p of items) {
            if (p.status !== 'open' && p.status !== 'needs_fix') continue;
            if (!kinds.includes(p.kind)) continue;
            if (targetKeyOf(p.target) !== targetKey) continue;
            if (aliveFingerprints.has(p.fingerprint)) continue;
            p.status = 'stale';
            p.error = 'Проблема больше не обнаруживается';
            p.updatedAt = nowIso();
            count++;
        }
        return count;
    });
}

export function targetKeyOf(target) {
    if (!target) return '';
    if (target.type === 'chat') return `chat:${target.chatId}`;
    if (target.type === 'world') return `world:${target.world}`;
    if (target.type === 'card') return `card:${target.avatar}`;
    return '';
}
