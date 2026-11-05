import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

export function newId(prefix = '') {
    return prefix + crypto.randomBytes(6).toString('hex');
}

export function nowIso() {
    return new Date().toISOString();
}

/**
 * Path inside parent? Protects against "../" in names coming from the app.
 */
export function isInside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function safeJoin(parent, ...parts) {
    const full = path.join(parent, ...parts);
    if (!isInside(parent, full)) {
        throw httpError(400, 'Недопустимый путь');
    }
    return full;
}

/** Keeps a file name a plain name: no slashes, no dots at the start. */
export function plainName(name) {
    const value = String(name ?? '');
    if (!value || value.includes('/') || value.includes('\\') || value.startsWith('.') || value.includes('\0')) {
        throw httpError(400, 'Недопустимое имя файла');
    }
    return value;
}

export function httpError(status, message, extra = {}) {
    const error = new Error(message);
    error.status = status;
    Object.assign(error, extra);
    return error;
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export async function writeFileAtomic(file, data) {
    const dir = path.dirname(file);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
}

export async function readJson(file, fallback) {
    try {
        const text = await fs.promises.readFile(file, 'utf8');
        return JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
        if (error.code === 'ENOENT') return structuredClone(fallback);
        throw error;
    }
}

export async function writeJson(file, value) {
    await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/** Simple promise queue per key so two writers never touch one file at once. */
const locks = new Map();
export async function withLock(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const chained = previous.then(() => current);
    locks.set(key, chained);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (locks.get(key) === chained) locks.delete(key);
    }
}

export function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

export function uniq(list) {
    return [...new Set(list)];
}
