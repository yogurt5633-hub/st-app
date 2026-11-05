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
