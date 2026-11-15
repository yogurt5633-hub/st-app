import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeZipFile } from '../plugin/lib/archive.mjs';
import { readExtensionPackage, extensionRepository, downloadExtensionRepository } from '../plugin/lib/extension-package.mjs';
import { installData, cleanItems } from '../plugin/lib/catalog.mjs';
import { catalogStatus, uninstallItem } from '../plugin/lib/catalog-status.mjs';
import { matchesCatalogFilters } from '../plugin/app/catalog-filters.js';

const manifest = JSON.stringify({ display_name: 'Example extension', js: 'index.js', css: 'style.css' });
async function fixture(t, prefix = '', extra = []) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernka-package-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sources = [['manifest.json', manifest], ['index.js', 'window.example = true;'], ['style.css', '.example { color: red; }'], ...extra];
    const files = [];
    for (const [i, [name, contents]] of sources.entries()) {
        const file = path.join(root, `file-${i}`);
        await fs.writeFile(file, contents);
        files.push({ name: prefix + name, path: file });
    }
    const zip = path.join(root, 'extension.zip');
    await writeZipFile(zip, files);
    return { root, data: await fs.readFile(zip) };
}

// The published files become executable in the browser: test the archive boundary before installing.
test('extension ZIP: root and GitHub wrapper both install, duplicates keep their own folders, removal backs up', async t => {
    const { root, data } = await fixture(t, 'repo-main/');
    const parsed = readExtensionPackage(data);
    assert.equal(parsed.title, 'Example extension');
    assert.deepEqual(parsed.entries.map(e => e.name), ['manifest.json', 'index.js', 'style.css']);
    const ctx = { handle: 'u', dirs: { root: path.join(root, 'user') } };
    const korrektorDir = path.join(ctx.dirs.root, 'korrektor');
    const first = await installData(ctx, 'extension', data, 'Example');
    const second = await installData(ctx, 'extension', data, 'Example');
    assert.notEqual(first.file, second.file);
    assert.equal(first.reload, true);
    const item = { id: 'extension-example', type: 'extension', name: 'Example', url: 'https://example.org/extension.zip' };
    const status = await catalogStatus({ ctx, korrektorDir, items: [item], tracked: { [item.id]: { type: 'extension', file: first.file } }, fetchImpl: () => { throw new Error('should not download for tracking'); } });
    assert.equal(status[item.id].file, first.file);
    const removed = await uninstallItem({ ctx, korrektorDir, item, file: first.file });
    assert.equal(removed.reload, true);
    assert.equal(await fs.readFile(path.join(ctx.dirs.root, removed.backup, 'index.js'), 'utf8'), 'window.example = true;');
    await assert.rejects(fs.access(path.join(ctx.dirs.root, 'extensions', first.file)));
    await fs.access(path.join(ctx.dirs.root, 'extensions', second.file, 'manifest.json'));
    await assert.rejects(uninstallItem({ ctx, korrektorDir, item, file: '..' }), /Недопустимое/);
});

test('extension ZIP rejects traversal, symlinks, duplicates, mismatched headers and excessive expanded sizes', async t => {
    const traversal = await fixture(t, '', [['../outside.js', 'bad']]);
    assert.throws(() => readExtensionPackage(traversal.data), /недопустимый путь/);
    const duplicates = await fixture(t, '', [['index.js', 'duplicate']]);
    assert.throws(() => readExtensionPackage(duplicates.data), /повторяются/);
    const { data } = await fixture(t);
    const end = data.length - 22;
    const central = data.readUInt32LE(end + 16);
    const link = Buffer.from(data);
    link.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
    assert.throws(() => readExtensionPackage(link), /Ссылки/);
    const bomb = Buffer.from(data);
    bomb.writeUInt32LE(11 * 1024 * 1024, central + 24);
    assert.throws(() => readExtensionPackage(bomb), /распакованного/);
    const mismatched = Buffer.from(data);
    mismatched[30] = 0x78;
    assert.throws(() => readExtensionPackage(mismatched), /повреждён/);
    const corrupt = Buffer.from(data);
    corrupt.writeUInt32LE(0, central + 16);
    assert.throws(() => readExtensionPackage(corrupt), /повреждён/);
});

test('extension ZIP requires a manifest and existing entry points, rejects unrelated trees before writing', async t => {
    const { root, data } = await fixture(t, 'repo/');
    const noManifest = Buffer.from(data);
    for (let i = 0; i < noManifest.length; i++) {
        if (noManifest.subarray(i, i + 13).toString() === 'manifest.json') noManifest.write('otherdoc.json', i);
    }
    assert.throws(() => readExtensionPackage(noManifest), /manifest.json/);
    const ctx = { handle: 'u', dirs: { root: path.join(root, 'user') } };
    await assert.rejects(installData(ctx, 'extension', noManifest, 'Example'), /manifest.json/);
    await assert.rejects(fs.access(ctx.dirs.root));
    const conflicting = await fixture(t, '', [['style.css/file', 'bad']]);
    assert.throws(() => readExtensionPackage(conflicting.data), /конфликтуют/);
});

test('GitHub extension import accepts only public repository URLs and uses a bounded ZIP download', async t => {
    const { data } = await fixture(t, 'owner-repo-sha/');
    assert.equal(extensionRepository('https://github.com/owner/repo.git').page, 'https://github.com/owner/repo');
    for (const url of ['http://github.com/a/b', 'https://localhost/a/b', 'https://github.com/a/b/tree/main', 'https://secret@github.com/a/b']) assert.throws(() => extensionRepository(url));
    const result = await downloadExtensionRepository('https://github.com/owner/repo', { fetchImpl: async url => {
        assert.equal(url, 'https://api.github.com/repos/owner/repo/zipball');
        return new Response(data);
    } });
    assert.equal(readExtensionPackage(result.data).title, 'Example extension');
    await assert.rejects(downloadExtensionRepository('https://github.com/a/b', { fetchImpl: async () => new Response('missing', { status: 404 }) }), /публичный/);
    await assert.rejects(downloadExtensionRepository('https://github.com/a/b', { fetchImpl: async () => new Response('', { headers: { 'content-length': 21 * 1024 * 1024 } }) }), /20 МБ/);
});

test('catalog languages and translations combine with type filters and preserve unknown metadata', () => {
    const items = cleanItems({ items: [
        { id: 'en', name: 'English', type: 'extension', url: 'https://example.org/a.zip', language: 'en', translated: false },
        { id: 'ru', name: 'Русский', type: 'card', url: 'https://example.org/a.png', language: 'ru', translated: true },
        { id: 'th', name: 'Thai', type: 'lorebook', url: 'https://example.org/a.json', language: 'th' },
        { id: 'zh', name: 'Chinese', type: 'preset', url: 'https://example.org/b.json', language: 'zh', translated: false },
        { id: 'old', name: 'Old', type: 'preset', url: 'https://example.org/c.json' },
    ] });
    assert.equal(items.length, 5);
    assert.deepEqual(items.filter(i => matchesCatalogFilters(i, { language: 'ru', translation: 'yes' })).map(i => i.id), ['ru']);
    assert.deepEqual(items.filter(i => matchesCatalogFilters(i, { translation: 'no' })).map(i => i.id), ['en', 'zh']);
    assert.deepEqual(items.filter(i => matchesCatalogFilters(i, { type: 'extension', language: 'en' })).map(i => i.id), ['en']);
    assert.equal(matchesCatalogFilters(items[2], { language: 'th' }), true);
    assert.equal(matchesCatalogFilters(items[4], { translation: 'no' }), false);
    assert.equal(items[4].language, '');
    assert.equal(items[4].translated, null);
});
