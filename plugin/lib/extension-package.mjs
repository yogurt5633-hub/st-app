import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from './archive.mjs';
import { httpError } from './util.mjs';

const MAX_ARCHIVE = 20 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_FILES = 2000;
const invalid = (message = 'ZIP-архив расширения повреждён') => httpError(400, message);

function safePath(name) {
    return name && name.length <= 240 && !/[\\:\x00-\x1f]/.test(name)
        && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
}

/** Validate entirely in memory before any files are installed. Never run archive contents. */
export function readExtensionPackage(data) {
    if (!Buffer.isBuffer(data) || data.length < 22) throw invalid('Нужен ZIP-архив расширения с manifest.json');
    if (data.length > MAX_ARCHIVE) throw httpError(413, 'Архив больше 20 МБ');
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
        if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
    }
    if (end < 0) throw invalid('Нужен обычный ZIP-архив расширения');
    const count = data.readUInt16LE(end + 10);
    const start = data.readUInt32LE(end + 16);
    const size = data.readUInt32LE(end + 12);
    if (!count || count > MAX_FILES) throw invalid('В архиве должно быть от 1 до 2000 файлов и папок');
    if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || start + size !== end) throw invalid();
    const files = [];
    const seen = new Set();
    let cursor = start;
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
        const flags = data.readUInt16LE(cursor + 8);
        const method = data.readUInt16LE(cursor + 10);
        const crc = data.readUInt32LE(cursor + 16);
        const compressed = data.readUInt32LE(cursor + 20);
        const length = data.readUInt32LE(cursor + 24);
        const nameLength = data.readUInt16LE(cursor + 28);
        const next = cursor + 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
        const mode = (data.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
        const offset = data.readUInt32LE(cursor + 42);
        if (next > end || data.readUInt16LE(cursor + 34)) throw invalid();
        const rawName = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const directory = rawName.endsWith('/');
        const name = directory ? rawName.slice(0, -1) : rawName;
        if (!safePath(name)) throw invalid('В архиве есть недопустимый путь к файлу');
        if (seen.has(name)) throw invalid('В архиве повторяются имена файлов');
        seen.add(name);
        if (mode && mode !== 0x8000 && mode !== 0x4000) throw invalid('Ссылки и специальные файлы в архиве не поддерживаются');
        if ((mode === 0x4000 && !directory) || (flags & 0x41) || ![0, 8].includes(method)) throw invalid('Сжатие или шифрование архива не поддерживается');
        if (length > MAX_FILE || (total += length) > MAX_TOTAL) throw httpError(413, 'Слишком большой размер распакованного расширения');
        if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50) throw invalid();
        const localNameLength = data.readUInt16LE(offset + 26);
        const bodyStart = offset + 30 + localNameLength + data.readUInt16LE(offset + 28);
        if (bodyStart + compressed > start || data.readUInt16LE(offset + 8) !== method || data.readUInt16LE(offset + 6) !== flags
            || data.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== rawName) throw invalid();
        let content;
        try {
            const packed = data.subarray(bodyStart, bodyStart + compressed);
            content = method === 0 ? packed : zlib.inflateRawSync(packed, { maxOutputLength: Math.min(MAX_FILE, Math.max(1, length)) });
        } catch { throw invalid(); }
        if (content.length !== length || crc32(content) !== crc) throw invalid();
        if (!directory && !name.startsWith('__MACOSX/') && path.posix.basename(name) !== '.DS_Store') files.push({ name, data: content });
        cursor = next;
    }
    if (cursor !== end) throw invalid();
    // Accept both a ready extension and GitHub's ZIP with one enclosing directory.
    let prefix = '';
    if (!files.some(file => file.name === 'manifest.json')) {
        const roots = [...new Set(files.map(file => file.name.split('/')[0]))];
        if (roots.length !== 1 || !files.some(file => file.name === `${roots[0]}/manifest.json`)) throw invalid('В ZIP нужен manifest.json в корне или в одной общей папке');
        prefix = roots[0] + '/';
    }
    const entries = files.map(file => ({ ...file, name: file.name.slice(prefix.length) }));
    const manifestFile = entries.find(file => file.name === 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(manifestFile.data.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw invalid('manifest.json не читается'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.display_name !== 'string' || !manifest.display_name.trim()) throw invalid('В manifest.json нужно название display_name');
    if (!manifest.js && !manifest.css) throw invalid('В manifest.json нужен файл js или css');
    for (const key of ['js', 'css']) {
        if (!manifest[key]) continue;
        if (typeof manifest[key] !== 'string' || !safePath(manifest[key].replace(/^\.\//, '')) || !entries.some(file => file.name === manifest[key].replace(/^\.\//, ''))) throw invalid(`Файл ${key} из manifest.json не найден в архиве`);
    }
    // A file cannot also be a parent directory of another file.
    const paths = new Set(entries.map(file => file.name));
    for (const file of entries) {
        const parts = file.name.split('/');
        for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw invalid('В архиве конфликтуют имена файлов и папок');
    }
    return { entries, manifest, title: manifest.display_name.trim().slice(0, 80) };
}

export function extensionsDir(ctx) {
    return ctx.dirs.extensions || path.join(ctx.dirs.root, 'extensions');
}

export async function installExtension(ctx, data, base) {
    const archive = readExtensionPackage(data);
    const root = extensionsDir(ctx);
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, `${base}-`));
    try {
        // The manifest is written last, so SillyTavern won't discover a partial installation.
        for (const entry of [...archive.entries].sort((a, b) => Number(a.name === 'manifest.json') - Number(b.name === 'manifest.json'))) {
            const target = path.join(directory, entry.name);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, entry.data, { flag: 'wx' });
        }
    } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
    }
    return { type: 'extension', name: archive.title, file: path.basename(directory), where: 'Расширения', reload: true };
}

export function extensionRepository(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw invalid('Нужна ссылка на репозиторий GitHub'); }
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !match) throw invalid('Укажите https://github.com/автор/репозиторий');
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    if ([owner, repo].some(part => !part || part === '.' || part === '..')) throw invalid('Неверное имя репозитория');
    return { page: `https://github.com/${owner}/${repo}`, archive: `https://api.github.com/repos/${owner}/${repo}/zipball` };
}

export async function downloadExtensionRepository(value, { fetchImpl = globalThis.fetch } = {}) {
    const repository = extensionRepository(value);
    const response = await fetchImpl(repository.archive, {
        signal: AbortSignal.timeout(60000), redirect: 'follow', headers: { 'User-Agent': 'Tavernka', Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw httpError(502, `GitHub ответил ${response.status}. Проверьте, что репозиторий публичный`);
    if (Number(response.headers.get('content-length') || 0) > MAX_ARCHIVE) throw httpError(413, 'Архив больше 20 МБ');
    const chunks = [];
    let size = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_ARCHIVE) throw httpError(413, 'Архив больше 20 МБ');
            chunks.push(Buffer.from(chunk));
        }
    } else {
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length > MAX_ARCHIVE) throw httpError(413, 'Архив больше 20 МБ');
        chunks.push(data);
    }
    return { data: Buffer.concat(chunks), page: repository.page };
}
