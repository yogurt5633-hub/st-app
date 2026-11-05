import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCardJson } from '../plugin/lib/cards.mjs';
import { collectFiles } from '../plugin/lib/archive.mjs';
import { loadCatalog } from '../plugin/lib/catalog.mjs';
import {
    publishItem, removeItem, setSubmitLink, readLocal, listLocal, saveCatalogUpload, cleanPreset, slug, checkToken, rawUrl, CATALOG_REPO,
} from '../plugin/lib/catalog-publish.mjs';
import { tinyPng } from './helpers.mjs';

/** GitHub's contents API for one repository, in memory. */
function fakeGitHub({ conflictOnce = false } = {}) {
    const files = new Map();
    let shaN = 0;
    let conflict = conflictOnce;
    const calls = [];
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method || 'GET';
        calls.push(`${method} ${decodeURIComponent(u.pathname)}`);
        assert.match(init.headers.Authorization, /^Bearer /);
        if (u.pathname === '/user') return reply(200, { login: 'owner' });
        if (u.pathname === `/repos/${CATALOG_REPO}`) return reply(200, { permissions: { push: true } });
        const prefix = `/repos/${CATALOG_REPO}/contents/`;
        const p = decodeURIComponent(u.pathname.slice(prefix.length));
        const body = init.body ? JSON.parse(init.body) : {};
        if (method === 'GET') {
            const f = files.get(p);
            return f ? reply(200, { content: f.content, sha: f.sha }) : reply(404, { message: 'Not Found' });
        }
        if (method === 'PUT') {
            const f = files.get(p);
            if (p === 'catalog/catalog.json' && conflict) {
                conflict = false;
                return reply(409, { message: 'sha mismatch' });
            }
            if (f && body.sha !== f.sha) return reply(409, { message: 'sha mismatch' });
            if (!f && body.sha) return reply(422, { message: 'no such file' });
            files.set(p, { content: body.content, sha: `s${++shaN}` });
            return reply(f ? 200 : 201, {});
        }
        if (method === 'DELETE') {
            const f = files.get(p);
            if (!f || f.sha !== body.sha) return reply(409, {});
            files.delete(p);
            return reply(200, {});
        }
        return reply(405, {});
    };
    const read = (p) => Buffer.from(files.get(p).content, 'base64');
    return { fetchImpl, files, calls, read, catalog: () => JSON.parse(read('catalog/catalog.json').toString('utf8')) };
}

function tavern() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'korrektor-catalog-'));
    const dirs = { root, openAI_Settings: path.join(root, 'OpenAI Settings'), worlds: path.join(root, 'worlds'), characters: path.join(root, 'characters') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Мой пресет.json'), JSON.stringify({ temperature: 1, openai_max_tokens: 500, prompts: [], proxy_password: 'hunter2', reverse_proxy: 'https://my.proxy', api_key_custom: 'sk-x' }));
    fs.writeFileSync(path.join(dirs.worlds, 'Мир.json'), JSON.stringify({ entries: { 0: { content: 'x' } } }));
    fs.writeFileSync(path.join(dirs.characters, 'Ника.png'), writeCardJson(tinyPng(), { name: 'Ника', data: { name: 'Ника' } }));
    fs.writeFileSync(path.join(root, 'secrets.json'), '{"api_key":"sk"}');
    const korrektorDir = path.join(root, 'korrektor');
    fs.mkdirSync(korrektorDir, { recursive: true });
    return { ctx: { handle: 'u', dirs }, korrektorDir, root };
}

const META = { name: 'Тёмное фэнтези', author: 'Лира', description: 'Пресет для мрачных историй', tags: 'фэнтези, мрак', allowed: true };

test('catalog author: a preset from the tavern is published without passwords; the record is on top', async () => {
    const t = tavern();
    const gh = fakeGitHub();
    const r = await publishItem({ ...t, token: 'github_pat_test', type: 'preset', source: { file: 'Мой пресет.json' }, meta: META, fetchImpl: gh.fetchImpl });
    assert.equal(r.item.id, 'preset-temnoe-fentezi');
    assert.deepEqual(r.removed.sort(), ['api_key_custom', 'proxy_password', 'reverse_proxy']);
    const published = JSON.parse(gh.read('catalog/files/presets/preset-temnoe-fentezi.json').toString('utf8'));
    assert.equal(published.proxy_password, undefined);
    assert.equal(published.api_key_custom, undefined);
    assert.equal(published.openai_max_tokens, 500, 'ordinary settings stay');
    const catalog = gh.catalog();
    assert.equal(catalog.items[0].url, rawUrl('catalog/files/presets/preset-temnoe-fentezi.json'));
    assert.deepEqual(catalog.items[0].tags, ['фэнтези', 'мрак']);
    // The same name again gets its own id; the newest is first.
    const again = await publishItem({ ...t, token: 'github_pat_test', type: 'preset', source: { file: 'Мой пресет.json' }, meta: META, fetchImpl: gh.fetchImpl });
    assert.equal(again.item.id, 'preset-temnoe-fentezi-2');
    assert.deepEqual(gh.catalog().items.map(i => i.id), ['preset-temnoe-fentezi-2', 'preset-temnoe-fentezi']);
    // The app sees the change at once, without GitHub's cache.
    assert.equal((await loadCatalog()).items[0].id, 'preset-temnoe-fentezi-2');
});

test('catalog author: author and permission are required; only files of the tavern folders', async () => {
    const t = tavern();
    const gh = fakeGitHub();
    const base = { ...t, token: 'github_pat_test', type: 'lorebook', source: { file: 'Мир.json' }, fetchImpl: gh.fetchImpl };
    await assert.rejects(publishItem({ ...base, meta: { ...META, allowed: false } }), /разрешения автора/);
    await assert.rejects(publishItem({ ...base, meta: { ...META, author: '' } }), /Нужен автор/);
    await assert.rejects(readLocal(t.ctx, 'preset', '../secrets.json'), /Нет такого файла/);
    await assert.rejects(readLocal(t.ctx, 'lorebook', 'Мой пресет.json'), /не найден/);
    assert.equal(gh.files.size, 0, 'nothing reached GitHub');
    assert.deepEqual((await listLocal(t.ctx, 'card')).map(i => i.name), ['Ника']);
});

test('catalog author: a card from the phone, removal with its file, the link for suggestions, a conflict', async () => {
    const t = tavern();
    const gh = fakeGitHub({ conflictOnce: true });
    const png = writeCardJson(tinyPng(), { name: 'Ника', data: { name: 'Ника' } });
    const up = await saveCatalogUpload(t.korrektorDir, 'card', png, 'nika.png');
    assert.equal(up.title, 'Ника');
    await assert.rejects(saveCatalogUpload(t.korrektorDir, 'card', Buffer.from('not a png'), 'x.png'), /не карточка/);
    const r = await publishItem({ ...t, token: 'github_pat_test', type: 'card', source: { upload: up.upload }, meta: { ...META, name: '' }, fetchImpl: gh.fetchImpl });
    assert.equal(r.item.name, 'Ника', 'the name comes from the card');
    assert.ok(gh.files.has('catalog/files/cards/card-nika.png'));
    assert.equal(fs.readdirSync(path.join(t.korrektorDir, 'catalog-uploads')).length, 0, 'the upload is cleaned up');

    await setSubmitLink({ token: 'github_pat_test', link: 'https://t.me/korrektor_owner', fetchImpl: gh.fetchImpl });
    assert.equal(gh.catalog().submit, 'https://t.me/korrektor_owner');
    await assert.rejects(setSubmitLink({ token: 'github_pat_test', link: 'javascript:alert(1)', fetchImpl: gh.fetchImpl }), /Не похоже на ссылку/);

    await removeItem({ token: 'github_pat_test', id: 'card-nika', fetchImpl: gh.fetchImpl });
    assert.equal(gh.catalog().items.length, 0);
    assert.equal(gh.files.has('catalog/files/cards/card-nika.png'), false);
    assert.equal(gh.catalog().submit, 'https://t.me/korrektor_owner', 'other fields stay');
});

test('catalog author: the token never goes into backups; odd tokens are refused before asking GitHub', async () => {
    const t = tavern();
    fs.writeFileSync(path.join(t.korrektorDir, 'catalog-admin.json'), '{"token":"github_pat_secret"}');
    fs.mkdirSync(path.join(t.korrektorDir, 'catalog-uploads'));
    fs.writeFileSync(path.join(t.korrektorDir, 'catalog-uploads', 'u1.png'), 'x');
    fs.writeFileSync(path.join(t.korrektorDir, 'settings.json'), '{}');
    const files = (await collectFiles(t.root)).map(f => f.rel ?? f.name ?? f.path ?? String(f));
    const flat = JSON.stringify(files);
    assert.ok(!flat.includes('catalog-admin'), flat);
    assert.ok(!flat.includes('catalog-uploads'), flat);
    assert.ok(!flat.includes('secrets.json'), flat);
    assert.ok(flat.includes('korrektor/settings.json'), flat);
    await assert.rejects(checkToken('not a token'), /не похоже на токен/);
});

test('catalog author: ids are latin, presets keep their own settings', () => {
    assert.equal(slug('Ромком в школе №2'), 'romkom-v-shkole-2');
    assert.equal(slug('!!!'), 'item');
    const { json, removed } = cleanPreset({ max_tokens: 10, openai_max_tokens: 20, custom_include_headers: 'Authorization: x', temperature: 0.7, token: 'x' });
    assert.deepEqual(json, { max_tokens: 10, openai_max_tokens: 20, temperature: 0.7 });
    assert.deepEqual(removed.sort(), ['custom_include_headers', 'token']);
});
