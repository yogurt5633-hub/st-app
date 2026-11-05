import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { httpError, isInside, writeFileAtomic } from './util.mjs';

// Full backup of the user's SillyTavern data as one ZIP file, and restore from it.
// secrets.json (API keys) is never read, packed or written. Thumbnails, vector
// indexes and SillyTavern's own backups are skipped: they are rebuilt or not needed.

const SKIP_DIRS = new Set(['backups', 'thumbnails', 'vectors', '_cache', '_uploads', '_storage', 'korrektor/backups', 'korrektor/archives', 'korrektor/catalog-uploads']);
const SKIP_FILES = new Set(['secrets.json']);
// The catalog author's GitHub token: like secrets.json, never packed.
const SKIP_PATHS = new Set(['korrektor/catalog-admin.json']);
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 3.5 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 65000;

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
    const d = new Date(date);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, day };
}

// ---------- which files ----------
function skipped(rel) {
    const parts = rel.split('/');
    if (parts.length === 1 && SKIP_FILES.has(parts[0])) return true;
    if (SKIP_PATHS.has(rel)) return true;
    for (let i = 1; i <= parts.length; i++) if (SKIP_DIRS.has(parts.slice(0, i).join('/'))) return true;
    return false;
}

/** Files of the user's data folder to pack: [{ name, path, size, mtime }]. */
export async function collectFiles(root) {
    const out = [];
    async function walk(dir, prefix) {
        let entries = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (skipped(rel) || entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, rel);
            } else if (entry.isFile()) {
                const stat = await fs.promises.stat(full);
                if (stat.size > MAX_FILE) continue;
                out.push({ name: rel, path: full, size: stat.size, mtime: stat.mtime });
            }
        }
    }
    await walk(root, '');
    return out;
}

export function summarize(files) {
    const folders = {};
    let bytes = 0;
    for (const f of files) {
        const top = f.name.includes('/') ? f.name.split('/')[0] : '(файлы)';
        folders[top] = (folders[top] || 0) + 1;
        bytes += f.size;
    }
    return { files: files.length, bytes, folders };
}

// ---------- writing ----------
function writeTo(out, buffer) {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        out.once('error', onError);
        const ok = out.write(buffer, () => {
            out.off('error', onError);
            if (ok) resolve();
        });
        if (!ok) out.once('drain', () => { out.off('error', onError); resolve(); });
    });
}

/** Streams a ZIP with the given files into a writable stream (an HTTP response or a file). */
export async function writeZip(out, files) {
    if (files.length > MAX_ENTRIES) throw httpError(413, 'Слишком много файлов для одного архива');
    const central = [];
    let offset = 0;
    for (const file of files) {
        let data;
        try {
            data = await fs.promises.readFile(file.path);
        } catch {
            continue; // removed meanwhile
        }
        const crc = crc32(data);
        const packed = zlib.deflateRawSync(data, { level: 6 });
        const useDeflate = packed.length < data.length;
        const body = useDeflate ? packed : data;
        if (offset + body.length > MAX_TOTAL) throw httpError(413, 'Данных слишком много для одного архива');
        const name = Buffer.from(file.name, 'utf8');
        const { time, day } = dosTime(file.mtime || Date.now());

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(useDeflate ? 8 : 0, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        await writeTo(out, local);
        await writeTo(out, name);
        await writeTo(out, body);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x0800, 8);
        entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
        entry.writeUInt16LE(time, 12);
        entry.writeUInt16LE(day, 14);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(body.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([entry, name]));
        offset += local.length + name.length + body.length;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    await writeTo(out, dir);
    await writeTo(out, end);
    return { files: central.length, bytes: offset + dir.length + end.length };
}

export async function writeZipFile(file, files) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(file);
    try {
        const result = await writeZip(out, files);
        await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())));
        return result;
    } catch (error) {
        out.destroy();
        await fs.promises.rm(file, { force: true });
        throw error;
    }
}

// ---------- reading ----------
async function readAt(handle, position, length) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
}

/** Lists the entries of a ZIP file without loading it whole. */
export async function readZipIndex(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const { size } = await handle.stat();
        const tailSize = Math.min(size, 65557);
        const tail = await readAt(handle, size - tailSize, tailSize);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw httpError(400, 'Это не ZIP-архив');
        const count = tail.readUInt16LE(eocd + 10);
        const dirSize = tail.readUInt32LE(eocd + 12);
        const dirOffset = tail.readUInt32LE(eocd + 16);
        if (dirOffset + dirSize > size) throw httpError(400, 'Архив повреждён');
        const dir = await readAt(handle, dirOffset, dirSize);
        const entries = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (dir.readUInt32LE(p) !== 0x02014b50) throw httpError(400, 'Архив повреждён');
            const nameLength = dir.readUInt16LE(p + 28);
            const extraLength = dir.readUInt16LE(p + 30);
            const commentLength = dir.readUInt16LE(p + 32);
            entries.push({
                method: dir.readUInt16LE(p + 10),
                crc: dir.readUInt32LE(p + 16),
                compressedSize: dir.readUInt32LE(p + 20),
                size: dir.readUInt32LE(p + 24),
                offset: dir.readUInt32LE(p + 42),
                name: dir.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
            });
            p += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    } finally {
        await handle.close();
    }
}

export async function readZipEntry(file, entry) {
    if (entry.size > MAX_FILE) throw httpError(413, `Файл ${entry.name} слишком большой`);
    const handle = await fs.promises.open(file, 'r');
    try {
        const header = await readAt(handle, entry.offset, 30);
        if (header.readUInt32LE(0) !== 0x04034b50) throw httpError(400, 'Архив повреждён');
        const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const body = await readAt(handle, start, entry.compressedSize);
        let data;
        if (entry.method === 0) data = body;
        else if (entry.method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: MAX_FILE });
        else throw httpError(400, `Неизвестное сжатие у файла ${entry.name}`);
        if (crc32(data) !== entry.crc) throw httpError(400, `Файл ${entry.name} в архиве повреждён`);
        return data;
    } finally {
        await handle.close();
    }
}

/** Where an entry would go; null if it must not be restored. */
export function targetFor(root, name) {
    const clean = String(name).replace(/\\/g, '/');
    if (!clean || clean.endsWith('/') || clean.startsWith('/') || clean.split('/').includes('..')) return null;
    if (skipped(clean)) return null;
    const target = path.join(root, ...clean.split('/'));
    return isInside(root, target) ? target : null;
}

/** What is inside an uploaded archive, before restoring it. */
export async function describeArchive(root, file) {
    const entries = await readZipIndex(file);
    const usable = entries.filter(e => targetFor(root, e.name));
    const folders = {};
    for (const e of usable) {
        const top = e.name.includes('/') ? e.name.split('/')[0] : '(файлы)';
        folders[top] = (folders[top] || 0) + 1;
    }
    const looksLikeSillyTavern = usable.some(e => e.name === 'settings.json' || /^(chats|characters|worlds)\//.test(e.name));
    return { files: usable.length, skipped: entries.length - usable.length, bytes: usable.reduce((s, e) => s + e.size, 0), folders, looksLikeSillyTavern };
}

/** Writes every allowed file from the archive into the data folder. Files not in the archive stay. */
export async function restoreArchive(root, file) {
    const entries = await readZipIndex(file);
    let restored = 0;
    for (const entry of entries) {
        const target = targetFor(root, entry.name);
        if (!target) continue;
        const data = await readZipEntry(file, entry);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await writeFileAtomic(target, data);
        restored++;
    }
    return { restored };
}

/** Saves an HTTP upload to a file (the body is a raw ZIP). */
export async function saveUpload(req, file, limit = MAX_TOTAL) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    if (Buffer.isBuffer(req.body) && req.body.length) {
        await fs.promises.writeFile(file, req.body);
        return req.body.length;
    }
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
                req.destroy();
                out.destroy();
                reject(httpError(413, 'Файл слишком большой'));
            }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve(total));
        req.pipe(out);
    });
}
