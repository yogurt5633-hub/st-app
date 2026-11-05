import { newId, nowIso } from './util.mjs';

// Long tasks (scans, model fixes) run in the background; the app polls their state.

const jobs = new Map();
const KEEP_MS = 30 * 60 * 1000;

export function startJob(handle, kind, fn, meta = {}) {
    const job = { id: newId('j'), handle, kind, meta, status: 'running', log: [], result: null, error: null, startedAt: nowIso(), finishedAt: null };
    jobs.set(job.id, job);
    const log = (line) => {
        job.log.push(line);
        if (job.log.length > 200) job.log.shift();
    };
    Promise.resolve()
        .then(() => fn(log))
        .then(result => {
            job.status = 'done';
            job.result = result ?? null;
        })
        .catch(error => {
            job.status = 'error';
            job.error = error?.message ?? String(error);
        })
        .finally(() => {
            job.finishedAt = nowIso();
            cleanup();
        });
    return job;
}

export function getJob(id, handle) {
    const job = jobs.get(id);
    return job && job.handle === handle ? job : null;
}

export function runningJob(handle, kind, metaMatch = () => true) {
    for (const job of jobs.values()) {
        if (job.handle === handle && job.kind === kind && job.status === 'running' && metaMatch(job.meta)) return job;
    }
    return null;
}

export function publicJob(job) {
    if (!job) return null;
    const { id, kind, meta, status, log, result, error, startedAt, finishedAt } = job;
    return { id, kind, meta, status, log, result, error, startedAt, finishedAt };
}

function cleanup() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt && now - Date.parse(job.finishedAt) > KEEP_MS) jobs.delete(id);
    }
}
