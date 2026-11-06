import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { translateText, languageName } from '../plugin/lib/translate.mjs';
import { chunkText } from '../st-extension/translate.js';

test('translate: the model gets the text and the language, the answer comes back clean', async () => {
    const calls = [];
    const llm = { complete: async (args) => { calls.push(args); return { text: '```\nПривет, *машет*\n```' }; } };
    const out = await translateText(llm, 'Hello, *waves*', 'ru');
    assert.equal(out, 'Привет, *машет*');
    assert.equal(calls[0].task, 'translate');
    assert.match(calls[0].system, /русский/);
    assert.equal(calls[0].user, 'Hello, *waves*');
    assert.equal(await translateText(llm, '   ', 'ru'), '');
    assert.equal(languageName('xx'), 'xx');
    await assert.rejects(translateText(llm, 'a'.repeat(20000), 'ru'), /слишком длинное/);
});

test('translate: long text is cut at paragraphs and sentences, nothing is lost', () => {
    const text = 'First paragraph here.\nSecond one is a bit longer. It has two sentences.\nThird.';
    const parts = chunkText(text, 30);
    assert.ok(parts.every(p => p.length <= 30));
    assert.equal(parts.join(''), text);
    assert.deepEqual(chunkText('short', 100), ['short']);
});

test('installer: copies the plugin and companion, turns on server plugins, can run twice', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'korrektor-install-'));
    const st = path.join(root, 'SillyTavern');
    fs.mkdirSync(path.join(st, 'data', 'default-user'), { recursive: true });
    fs.mkdirSync(path.join(st, 'default'), { recursive: true });
    fs.mkdirSync(path.join(st, 'plugins', '.korrektor-new'), { recursive: true });
    fs.writeFileSync(path.join(st, 'package.json'), '{"name":"sillytavern"}');
    fs.writeFileSync(path.join(st, 'server.js'), '');
    fs.writeFileSync(path.join(st, 'data', 'default-user', 'settings.json'), '{}');
    fs.writeFileSync(path.join(st, 'default', 'config.yaml'), 'listen: false\nenableServerPlugins: false\n');
    const script = path.resolve('scripts/install.mjs');
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, [script, st], { stdio: 'pipe' });
    const version = JSON.parse(fs.readFileSync('plugin/package.json', 'utf8')).version;
    assert.equal(JSON.parse(fs.readFileSync(path.join(st, 'plugins', 'korrektor', 'package.json'), 'utf8')).version, version);
    assert.ok(fs.existsSync(path.join(st, 'data', 'default-user', 'extensions', 'korrektor-sync', 'translate.js')));
    assert.match(fs.readFileSync(path.join(st, 'config.yaml'), 'utf8'), /^enableServerPlugins: true$/m);
    // Nothing left behind: no temporary folders, the old installer's leftover is gone.
    assert.deepEqual(fs.readdirSync(path.join(st, 'plugins')), ['korrektor']);
    assert.ok(!fs.readdirSync(st).some(n => n.startsWith('.korrektor-install')));
});

test('translate: a piece that comes back half in English is split and translated again; code blocks are translated, fences kept', async () => {
    const { translator, looksUntranslated } = await import('../st-extension/translate.js');
    const calls = [];
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}), extensionSettings: {} }) };
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        calls.push([url, text.length]);
        // Like the free Google endpoint with long text: only the first part comes back translated.
        const out = text.length > 600 ? `ПЕРЕВОД ${text.slice(0, 100)}${text.slice(100)}` : text.replace(/[A-Za-z]+/g, 'слово');
        return { ok: true, status: 200, text: async () => out };
    };
    const long = Array.from({ length: 12 }, (_, i) => `Line ${i}: the knight walks into the tavern and orders some ale.`).join('\n');
    const source = `${long}\n\`\`\`\nHP: full, Mood: calm and happy today\n\`\`\``;
    const out = await translator('google', 'ru')(source);
    assert.ok(!/knight|tavern|calm/.test(out), out);
    assert.match(out, /```\n[^`]*слово[^`]*\n```$/);
    assert.ok(calls.some(([, n]) => n <= 600), 'smaller pieces were asked for');
    assert.equal(looksUntranslated('The knight walks into the tavern.', 'Рыцарь входит в таверну.', 'ru'), false);
    assert.equal(looksUntranslated('The knight walks into the tavern.', 'The knight walks into the tavern.', 'ru'), true);
    assert.equal(looksUntranslated('Привет, как дела у тебя сегодня?', 'Привет, как дела у тебя сегодня?', 'ru'), false);
});

test('translate: dashes and spaced asterisks from translators do not turn lines into a bulleted list', async () => {
    const { fixMarkup } = await import('../st-extension/translate.js');
    assert.equal(fixMarkup('"You want me to repay it now?" he said', '- Ты хочешь, чтобы я вернул его сейчас? он сказал'), '— Ты хочешь, чтобы я вернул его сейчас? он сказал');
    assert.equal(fixMarkup('*smiles* Hello', '* улыбается * Привет'), '*улыбается* Привет');
    assert.equal(fixMarkup('She *really* likes it', 'Она * очень * это любит'), 'Она *очень* это любит');
    assert.equal(fixMarkup('*a* text *b*', '*а* текст *б*'), '*а* текст *б*');
    assert.equal(fixMarkup('- one\n- two', '- один\n- два'), '- один\n- два', 'a real list stays a list');
});

test('translate: status blocks, tables and lines already in Russian keep their shape; only foreign lines are sent', async () => {
    const { translator, alreadyTarget } = await import('../st-extension/translate.js');
    const sent = [];
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}), extensionSettings: {} }) };
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        sent.push(text);
        // Like a free translator: words translated, newlines and pipes not respected, quotes as entities.
        const out = text.replace(/[A-Za-z]+/g, 'слово').replace(/\|/g, ' ').replace(/"/g, '&quot;');
        return { ok: true, status: 200, text: async () => out };
    };
    const post = [
        'The knight walks into the tavern.',
        'He orders "ale".',
        '```',
        '━━━━━━━━━━',
        '📍 Локация: Таверна «Сломанный рог»',
        '❤️ HP: 100/100',
        '| Name | Mood |',
        '|------|------|',
        '| Lira | happy |',
        '```',
        '<div class="status">Настроение: спокойное</div>',
    ].join('\n');
    const out = await translator('google', 'ru')(post);
    const lines = out.split('\n');
    assert.equal(lines[0], 'слово слово слово слово слово слово.');
    assert.equal(lines[1], 'слово слово "слово".', 'entities come back as characters');
    for (const kept of ['```', '━━━━━━━━━━', '📍 Локация: Таверна «Сломанный рог»', '❤️ HP: 100/100', '|------|------|', '<div class="status">Настроение: спокойное</div>']) {
        assert.ok(lines.includes(kept), `kept as is: ${kept}`);
    }
    assert.ok(lines.includes('| слово | слово |') && lines.includes('| слово | слово |'), out);
    assert.ok(!sent.some(t => /[А-Яа-яЁё]/.test(t)), `nothing Russian was sent: ${JSON.stringify(sent)}`);
    assert.ok(!sent.some(t => t.includes('|')), 'table pipes are not sent');
    assert.equal(alreadyTarget('Лира усмехнулась, глядя на Nika', 'ru'), true);
    assert.equal(alreadyTarget('Lira smiled at Ника', 'ru'), false);
});

test('translate: a reply that starts with names and places is translated, the names may stay in Latin', async () => {
    const { translator, looksUntranslated } = await import('../st-extension/translate.js');
    const calls = [];
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}), extensionSettings: {} }) };
    // Like a model: ordinary words translated, names, places and dates kept as they are.
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        calls.push(text);
        return { ok: true, status: 200, json: async () => ({ text: text.replace(/(?<![A-Za-z])[a-z][a-z']*/g, 'слово') }) };
    };
    const reply = [
        'Friday, November 6, 2026, 23:41',
        'Room 314, Calloway Hall, Whitmore University, Hadley Falls, Massachusetts',
        '',
        'Nico was not waiting up.',
        '',
        'He was working. There was a difference, and the difference was the half-finished model.',
    ].join('\n');
    const out = await translator('model', 'ru')(reply);
    assert.match(out, /Room 314, Calloway Hall, Whitmore University/);
    assert.match(out, /Nico слово слово слово слово\./);
    assert.equal(out.split('\n').length, reply.split('\n').length, 'paragraphs keep their places');
    assert.equal(calls.length, 1, 'one reply is one request to the model');
    assert.equal(looksUntranslated('Room 314, Calloway Hall, Whitmore University, Hadley Falls', 'Комната 314, Calloway Hall, Whitmore University, Hadley Falls', 'ru'), false);
    assert.equal(looksUntranslated('He was working. There was a difference.', 'Он работал. There was a difference.', 'ru'), true);
});
