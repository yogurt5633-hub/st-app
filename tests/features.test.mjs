import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { logUsage, usageSummary, setPrice, priceFor, dayOf } from '../plugin/lib/usage.mjs';
import { usageOf } from '../plugin/lib/llm.mjs';
import { cardHealth } from '../plugin/lib/health.mjs';
import { recapRange, foundSince } from '../plugin/lib/recap.mjs';
import { noteRejection, setMuted } from '../plugin/lib/mute.mjs';
import { collectFiles, writeZipFile, readZipIndex, readZipEntry, describeArchive, restoreArchive, targetFor, crc32 } from '../plugin/lib/archive.mjs';
import { cleanItems, safeFileName, installItem } from '../plugin/lib/catalog.mjs';
import { writeCardJson } from '../plugin/lib/cards.mjs';
import { makeUser, tinyPng } from './helpers.mjs';

test('usage: roleplay and Korrektor calls add up per day, model and chat; expensive chats show up', async () => {
    const { store, cleanup } = makeUser();
    await store.ensureDir();
    const now = new Date('2026-11-05T12:00:00');
    await logUsage(store, { kind: 'roleplay', model: 'claude-opus-5-5', chatId: 'c/Nika/chat1', input: 42000, output: 600 }, now);
    await logUsage(store, { kind: 'roleplay', model: 'claude-opus-5-5', chatId: 'c/Nika/chat1', input: 43000, output: 500 }, now);
    await logUsage(store, { kind: 'korrektor', model: 'claude-haiku-5-5', input: 3000, output: 200 }, now);
    await logUsage(store, { kind: 'roleplay', model: 'x', input: 0, output: 0 }, now); // nothing to count
    await setPrice(store, 'claude-opus-5-5', 5, 25);
    const prices = { 'claude-opus-5-5': { input: 5, output: 25 } };
    const sum = await usageSummary(store, { days: 7, prices, fetched: {}, now, expensiveTokens: 30000 });
    assert.equal(sum.total.roleplay.calls, 2);
    assert.equal(sum.total.roleplay.input, 85000);
    assert.equal(sum.total.korrektor.output, 200);
    assert.equal(sum.byDay.at(-1).day, dayOf(now));
    assert.equal(sum.byDay.length, 7);
    const opus = sum.models.find(m => m.model === 'claude-opus-5-5');
    assert.ok(Math.abs(opus.cost - (85000 * 5 + 1100 * 25) / 1e6) < 1e-9);
    assert.equal(sum.models.find(m => m.model === 'claude-haiku-5-5').cost, null);
    assert.equal(sum.unpriced, true);
    assert.deepEqual(sum.expensive.map(e => [e.chatId, e.tokens]), [['c/Nika/chat1', 43000]]);
    cleanup();
});

test('usage: token counts from OpenAI, Claude and Gemini replies; prices from the user win over OpenRouter', () => {
    assert.deepEqual(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 3 } }), { input: 10, output: 3 });
    assert.deepEqual(usageOf({ usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 } }), { input: 15, output: 2 });
    assert.deepEqual(usageOf({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, thoughtsTokenCount: 4 } }), { input: 7, output: 5 });
    assert.equal(usageOf({ choices: [] }), null);
    const fetched = { 'anthropic/claude-opus-5-5': { input: 6, output: 30 } };
    assert.equal(priceFor('anthropic/claude-opus-5-5', {}, fetched).from, 'OpenRouter');
    assert.equal(priceFor('anthropic/claude-opus-5-5', { 'anthropic/claude-opus-5-5': { input: 1, output: 2 } }, fetched).from, 'вы');
    assert.equal(priceFor('unknown', {}, fetched), null);
});

test('card health: a good card scores high, an empty and junky one low with tips', () => {
    const good = { data: {
        description: 'Ника — травница из северной деревни. Серые глаза, тёмная коса, говорит тихо и коротко. Любит запах мяты, не терпит лжи и шумных ярмарок. Носит серебряный амулет матери и никогда его не снимает.',
        personality: 'спокойная, упрямая', scenario: 'Зима, деревня отрезана снегом.',
        first_mes: 'Ника поднимает глаза от ступки: «Вы промокли. Садитесь к огню».',
        mes_example: '<START>\n{{user}}: Привет\n{{char}}: «Здравствуйте».',
    } };
    const g = cardHealth(good, 'nika.png');
    assert.ok(g.score >= 90, `score ${g.score}`);
    assert.equal(g.verdict, 'В порядке');

    const bad = { data: { description: '<div style="x">Тест</div> https://example.com', first_mes: '' } };
    const proposals = [{ status: 'open', target: { avatar: 'bad.png' }, id: 'p1' }];
    const b = cardHealth(bad, 'bad.png', { proposals });
    assert.ok(b.score < 50, `score ${b.score}`);
    assert.ok(b.tips.some(t => /разметка/.test(t.text)));
    assert.ok(b.tips.some(t => /первого сообщения/.test(t.text)));
    assert.deepEqual(b.open, ['p1']);
});

test('session recap: first time takes the latest messages, then only new ones', () => {
    const chat = { messages: Array.from({ length: 50 }, (_, i) => ({ mes: `m${i}`, is_system: i === 3 })) };
    const first = recapRange(chat, null);
    assert.equal(first.indices.length, 30);
    assert.equal(first.to, 49);
    const next = recapRange(chat, { to: 45 });
    assert.deepEqual(next.indices, [46, 47, 48, 49]);
    assert.equal(recapRange(chat, { to: 49 }).nothingNew, true);
    const found = foundSince([
        { kind: 'new_fact', target: { chatId: 'c/a/1' }, createdAt: '2026-11-05T10:00:00Z' },
        { kind: 'new_fact', chats: ['c/a/1'], createdAt: '2026-11-05T12:00:00Z' },
        { kind: 'contradiction', target: { chatId: 'c/b/1' }, createdAt: '2026-11-05T12:00:00Z' },
    ], 'c/a/1', '2026-11-05T11:00:00Z');
    assert.deepEqual(found, { new_fact: 1 });
});

test('learning from rejections: asks once after three rejections of a kind, muted kinds are not asked', async () => {
    const { store, cleanup } = makeUser();
    await store.ensureDir();
    assert.equal((await noteRejection(store, 'slop')).suggestMute, null);
    assert.equal((await noteRejection(store, 'slop')).suggestMute, null);
    assert.equal((await noteRejection(store, 'slop')).suggestMute, 'slop');
    assert.equal((await noteRejection(store, 'slop')).suggestMute, null); // asked already
    assert.equal((await noteRejection(store, 'manual')).suggestMute, null);
    await setMuted(store, 'repetition', true);
    for (let i = 0; i < 3; i++) assert.equal((await noteRejection(store, 'repetition')).suggestMute, null);
    assert.deepEqual((await store.getSettings()).muted, ['repetition']);
    assert.deepEqual(await setMuted(store, 'repetition', false), []);
    cleanup();
});

test('backup archive: packs data without secrets.json, restores it, refuses unsafe paths', async () => {
    const { dirs, cleanup } = makeUser();
    fs.writeFileSync(path.join(dirs.root, 'secrets.json'), '{"api_key":"sk-secret"}');
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), '{"a":1}');
    fs.mkdirSync(path.join(dirs.root, 'thumbnails'), { recursive: true });
    fs.writeFileSync(path.join(dirs.root, 'thumbnails', 'x.png'), 'thumb');
    fs.mkdirSync(path.join(dirs.root, 'korrektor', 'backups', 'b1'), { recursive: true });
    fs.writeFileSync(path.join(dirs.root, 'korrektor', 'backups', 'b1', 'f'), 'old');

    const files = await collectFiles(dirs.root);
    const names = files.map(f => f.name).sort();
    assert.ok(names.includes('settings.json'));
    assert.ok(names.includes('chats/Nika/chat1.jsonl'));
    assert.ok(names.includes('characters/Nika.png'));
    assert.ok(!names.some(n => n.includes('secrets') || n.startsWith('thumbnails/') || n.startsWith('korrektor/backups')));

    const zip = path.join(os.tmpdir(), `korrektor-test-${Date.now()}.zip`);
    await writeZipFile(zip, files);
    // The archive opens with the standard unzip tool, when there is one.
    try {
        const listing = execFileSync('unzip', ['-l', zip], { encoding: 'utf8' });
        assert.ok(listing.includes('chats/Nika/chat1.jsonl'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const index = await readZipIndex(zip);
    const chatEntry = index.find(e => e.name === 'chats/Nika/chat1.jsonl');
    assert.equal((await readZipEntry(zip, chatEntry)).toString('utf8'), fs.readFileSync(path.join(dirs.chats, 'Nika', 'chat1.jsonl'), 'utf8'));

    const info = await describeArchive(dirs.root, zip);
    assert.equal(info.looksLikeSillyTavern, true);
    assert.equal(info.files, files.length);

    // Change a file, restore: it comes back. Files not in the archive stay.
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), '{"a":2}');
    fs.writeFileSync(path.join(dirs.root, 'new.txt'), 'keep me');
    const result = await restoreArchive(dirs.root, zip);
    assert.equal(result.restored, files.length);
    assert.equal(fs.readFileSync(path.join(dirs.root, 'settings.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(dirs.root, 'new.txt'), 'utf8'), 'keep me');
    assert.equal(fs.readFileSync(path.join(dirs.root, 'secrets.json'), 'utf8'), '{"api_key":"sk-secret"}');

    assert.equal(targetFor(dirs.root, '../evil.txt'), null);
    assert.equal(targetFor(dirs.root, '/etc/passwd'), null);
    assert.equal(targetFor(dirs.root, 'secrets.json'), null);
    assert.equal(targetFor(dirs.root, 'a/../../x'), null);
    assert.ok(targetFor(dirs.root, 'worlds/Мир.json').endsWith(path.join('worlds', 'Мир.json')));
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    fs.rmSync(zip, { force: true });
    cleanup();
});

test('catalog: keeps only valid https items; install never overwrites and checks the file type', async () => {
    const items = cleanItems({ items: [
        { id: 'a', type: 'lorebook', name: 'Мир', url: 'https://x/a.json' },
        { id: 'b', type: 'lorebook', name: 'Плохо', url: 'http://x/b.json' },
        { id: 'c', type: 'theme', name: 'Тема', url: 'https://x/c.json' },
        { id: 'd', type: 'card', name: 'Ника', url: 'https://x/d.png' },
    ] });
    assert.deepEqual(items.map(i => i.id), ['a', 'd']);
    assert.equal(safeFileName('../a/b:c'), '_a_b_c');

    const { ctx, dirs, cleanup } = makeUser();
    ctx.dirs.openAI_Settings = path.join(dirs.root, 'OpenAI Settings');
    const files = {
        'https://x/a.json': Buffer.from(JSON.stringify({ entries: { 0: { uid: 0, key: ['k'], content: 'c' } } })),
        'https://x/d.png': writeCardJson(tinyPng(), { name: 'Ника', data: { name: 'Ника' } }),
        'https://x/notcard.png': tinyPng(),
        'https://x/p.json': Buffer.from('{"temperature":1}'),
    };
    const fetchImpl = async (url) => ({
        ok: Boolean(files[url]),
        status: files[url] ? 200 : 404,
        headers: { get: () => null },
        arrayBuffer: async () => files[url],
    });
    const world = await installItem(ctx, { type: 'lorebook', name: 'Мир', url: 'https://x/a.json' }, { fetchImpl });
    assert.equal(world.name, 'Мир (2)'); // "Мир.json" already exists
    assert.ok(fs.existsSync(path.join(dirs.worlds, 'Мир (2).json')));
    const card = await installItem(ctx, { type: 'card', name: 'Ника', url: 'https://x/d.png' }, { fetchImpl });
    assert.equal(card.name, 'Ника');
    await assert.rejects(installItem(ctx, { type: 'card', name: 'X', url: 'https://x/notcard.png' }, { fetchImpl }), /не карточка/);
    const preset = await installItem(ctx, { type: 'preset', name: 'Пресет', url: 'https://x/p.json' }, { fetchImpl });
    assert.ok(fs.existsSync(path.join(ctx.dirs.openAI_Settings, `${preset.name}.json`)));
    await assert.rejects(installItem(ctx, { type: 'lorebook', name: 'Y', url: 'https://x/none.json' }, { fetchImpl }), /404/);
    cleanup();
});
