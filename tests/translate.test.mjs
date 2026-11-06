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
    let reply = { text: '```\nПривет, *машет*\n```', model: 'm1' };
    const llm = { settings: { models: { translateEffort: 'low' } }, complete: async (args) => { calls.push(args); return reply; } };
    const out = await translateText(llm, 'Hello, *waves*', 'ru');
    assert.equal(out.text, 'Привет, *машет*');
    assert.equal(out.cut, false);
    assert.equal(out.via, 'tavern');
    assert.equal(calls[0].task, 'translate');
    assert.equal(calls[0].effort, 'fast', 'translation asks for as little thinking as possible');
    assert.match(calls[0].system, /русский/);
    assert.equal(calls[0].user, 'Hello, *waves*');
    assert.equal((await translateText(llm, '   ', 'ru')).text, '');
    assert.equal(languageName('xx'), 'xx');
    await assert.rejects(translateText(llm, 'a'.repeat(20000), 'ru'), /слишком длинное/);
    // A code block the message itself ends with keeps its closing fence.
    reply = { text: 'Статус:\n```\nХП: 10\n```' };
    assert.equal((await translateText(llm, 'Status:\n```\nHP: 10\n```', 'ru')).text, 'Статус:\n```\nХП: 10\n```');
    // The model's own thinking goes; a thinking block that is part of the message stays.
    reply = { text: '<think>hm</think>Привет' };
    assert.equal((await translateText(llm, 'Hello', 'ru')).text, 'Привет');
    reply = { text: '<thinking>Она думает</thinking>\nПривет', cut: true };
    const kept = await translateText(llm, '<thinking>She thinks</thinking>\nHello', 'ru');
    assert.equal(kept.text, '<thinking>Она думает</thinking>\nПривет');
    assert.equal(kept.cut, true, 'a cut answer is reported');
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

test('translate: «Стоп» cuts off a request that hangs', async () => {
    const { translator } = await import('../st-extension/translate.js');
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}), extensionSettings: {} }) };
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const controller = new AbortController();
    const pending = translator('model', 'ru', controller.signal)('The knight walks into the tavern and smiles.');
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (e) => e.stopped === true);
});

function fakeTavern() {
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}), extensionSettings: {} }) };
}

test('translate: a free translator that drops the end of a piece: the piece is split and translated again, nothing is lost', async () => {
    const { translator, looksCut } = await import('../st-extension/translate.js');
    fakeTavern();
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        calls.push(text.length);
        // Like Google with longer text: only the first third comes back.
        const words = text.replace(/[A-Za-z]+/g, 'слово');
        const out = text.length > 500 ? words.slice(0, Math.floor(words.length / 3)) : words;
        return { ok: true, status: 200, text: async () => out };
    };
    const source = Array.from({ length: 10 }, (_, i) => `Line ${i}: the knight walks into the tavern and orders ale.`).join(' ');
    const out = await translator('google', 'ru')(source);
    assert.ok(!looksCut(source, out, 'ru'), `whole: ${out.length} of ${source.length}`);
    assert.match(out, /слово 9: .*слово\.$/, 'the last line is there');
    assert.ok(calls.some(n => n <= 500), 'smaller pieces were asked for');
    assert.equal(looksCut('word '.repeat(100), 'слово '.repeat(30), 'ru'), true);
    assert.equal(looksCut('word '.repeat(100), 'слово '.repeat(90), 'ru'), false);
    assert.equal(looksCut('short text', '', 'ru'), false, 'short texts are not judged');
});

test('translate: a model answer cut at the length limit is translated again in parts; a long reply goes in parts at once', async () => {
    const { translator } = await import('../st-extension/translate.js');
    fakeTavern();
    const seen = [];
    let active = 0;
    let most = 0;
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        seen.push(text.length);
        active++;
        most = Math.max(most, active);
        await new Promise(r => setTimeout(r, 20));
        active--;
        const words = text.replace(/[A-Za-z]+/g, 'слово');
        // The whole text is too long for the model's limit: its answer stops halfway.
        if (text.length > 2500) return { ok: true, status: 200, json: async () => ({ text: words.slice(0, 900), cut: true, model: 'm' }) };
        return { ok: true, status: 200, json: async () => ({ text: words, model: 'm' }) };
    };
    const paragraph = 'The knight walks into the tavern, looks around and orders some ale for his tired friends.';
    const reply = Array.from({ length: 34 }, () => paragraph).join('\n\n');
    const out = await translator('model', 'ru')(reply);
    assert.ok(!/knight|tavern/.test(out), 'all of it is translated');
    assert.equal(out.split('\n\n').length, reply.split('\n\n').length, 'paragraphs keep their places');
    assert.ok(seen.length > 1 && seen.every(n => n <= 3100), `in parts: ${seen}`);
    assert.ok(most >= 2, 'parts go at the same time');
});

test('translate: parts of a message are cut outside HTML blocks and code blocks, and join back to the text', async () => {
    const { splitParts } = await import('../st-extension/translate.js');
    const text = 'One.\n\n<details>\n<summary>Status</summary>\n\nInside.\n\nMore inside.\n</details>\n\nTwo.\n\n```\na\n\nb\n```\n\nThree.';
    const parts = splitParts(text, 10);
    assert.equal(parts.join(''), text);
    assert.ok(parts.some(p => p.startsWith('<details>') && p.includes('</details>')), 'the block stays whole');
    assert.ok(parts.some(p => p.startsWith('```') && p.trim().endsWith('```')), 'the code block stays whole');
    assert.deepEqual(splitParts('short', 100), ['short']);
});

test('translate: a saved translation that lost its end is found', async () => {
    const { translationCut } = await import('../st-extension/translate.js');
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}), extensionSettings: {}, chat: [] }) };
    globalThis.localStorage = { getItem: () => null, setItem: () => { } };
    const mes = 'The knight walks into the tavern and orders ale. '.repeat(12);
    assert.equal(translationCut({ mes, extra: { display_text: 'Рыцарь входит в таверну.' } }), true);
    assert.equal(translationCut({ mes, extra: { display_text: 'Рыцарь входит в таверну и заказывает эль. '.repeat(12) } }), false);
    assert.equal(translationCut({ mes, extra: {} }), false);
    // Made by this version: compared with the source it was translated from.
    assert.equal(translationCut({ mes: 'x', extra: { display_text: 'Коротко.', korrektor_translation: { letters: 900, lang: 'ru' } } }), true);
});

test('translate key: saved apart, never shown back, used directly; a cut answer is reported; the check translates one line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'korrektor-key-'));
    const { saveKeyConfig, readKeyConfig, publicKeyConfig, completeWithKey, checkKey } = await import('../plugin/lib/translate-key.mjs');
    await assert.rejects(saveKeyConfig(dir, { provider: 'nope' }), /чей это ключ/);
    let cfg = await saveKeyConfig(dir, { provider: 'openrouter', key: 'sk-or-secret-1234', model: 'google/gemini-2.5-flash' });
    const shown = publicKeyConfig(cfg);
    assert.equal(shown.hasKey, true);
    assert.equal(shown.keyHint, '…1234');
    assert.equal(shown.active, true);
    assert.ok(!JSON.stringify(shown).includes('secret'), 'the key is never in what the page gets');
    // A new model without a new key keeps the key.
    cfg = await saveKeyConfig(dir, { model: 'openai/gpt-5-mini' });
    assert.equal((await readKeyConfig(dir)).key, 'sk-or-secret-1234');
    assert.equal((fs.statSync(path.join(dir, 'translate-key.json')).mode & 0o777), 0o600);

    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5-mini' }, { id: 'x/y' }] }));
        if (url.includes('anthropic')) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Привет' }], stop_reason: 'max_tokens', model: 'claude-haiku-5-5', usage: { input_tokens: 5, output_tokens: 7 } }));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'В таверне было тихо.' }, finish_reason: 'stop' }], model: 'openai/gpt-5-mini' }));
    };
    const out = await completeWithKey(cfg, { system: 's', user: 'u', maxTokens: 100, fetchImpl });
    assert.equal(out.text, 'В таверне было тихо.');
    assert.equal(out.cut, false);
    const sent = requests[0];
    assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(sent.init.headers.Authorization, 'Bearer sk-or-secret-1234');
    assert.equal(sent.body.max_completion_tokens, 100, 'reasoning models get max_completion_tokens');

    const claude = await saveKeyConfig(dir, { provider: 'anthropic', key: 'sk-ant-xyz9', model: 'claude-haiku-5-5' });
    const answer = await completeWithKey(claude, { system: 's', user: 'u', maxTokens: 100, fetchImpl });
    assert.equal(answer.cut, true, 'stop_reason max_tokens = the end is missing');
    const claudeReq = requests.at(-1);
    assert.equal(claudeReq.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(claudeReq.init.headers['x-api-key'], 'sk-ant-xyz9');
    assert.equal(claudeReq.body.output_config.effort, 'low');
    assert.equal(claudeReq.body.system, 's');

    const check = await checkKey(await saveKeyConfig(dir, { provider: 'openrouter', key: 'sk-or-new-5678', model: 'openai/gpt-5-mini' }), { fetchImpl });
    assert.equal(check.ok, true, check.message);
    assert.match(check.message, /Работает/);
    assert.deepEqual(check.models, ['openai/gpt-5-mini', 'x/y']);
    const refused = await checkKey(cfg, { fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }) });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /ключ не принят/);

    await saveKeyConfig(dir, { clear: true });
    assert.equal(publicKeyConfig(await readKeyConfig(dir)).hasKey, false);
});

test('translate key: never packed into a backup', async () => {
    const { collectFiles } = await import('../plugin/lib/archive.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'korrektor-arch-'));
    fs.mkdirSync(path.join(root, 'korrektor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'korrektor', 'translate-key.json'), '{"key":"secret"}');
    fs.writeFileSync(path.join(root, 'korrektor', 'settings.json'), '{}');
    const names = (await collectFiles(root)).map(f => f.name);
    assert.ok(names.includes('korrektor/settings.json'));
    assert.ok(!names.includes('korrektor/translate-key.json'));
});

test('llm: translation thinks as little as the model allows; a cut answer is noticed', async () => {
    const { fastEffort, wasCut } = await import('../plugin/lib/llm.mjs');
    assert.equal(fastEffort('claude', 'claude-haiku-4-5'), 'auto', 'older Claude: no thinking at all');
    assert.equal(fastEffort('claude', 'claude-sonnet-5-5'), 'low');
    assert.equal(fastEffort('makersuite', 'gemini-2.5-flash'), 'min');
    assert.equal(fastEffort('openai', 'gpt-5-mini'), 'low');
    assert.equal(fastEffort('openrouter', 'deepseek/deepseek-chat'), 'auto');
    assert.equal(wasCut({ choices: [{ finish_reason: 'length' }] }), true);
    assert.equal(wasCut({ stop_reason: 'max_tokens' }), true);
    assert.equal(wasCut({ choices: [{ finish_reason: 'stop' }] }), false);
});

test('translate: shown as it goes — finished parts take the place of the original, the rest waits in the original', async () => {
    const { translator } = await import('../st-extension/translate.js');
    fakeTavern();
    const bodies = [];
    let n = 0;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        // Parts answer at different times: the later ones take longer.
        await new Promise(r => setTimeout(r, 40 + 150 * n++));
        return { ok: true, status: 200, json: async () => ({ text: body.text.replace(/[A-Za-z]+/g, 'слово'), model: 'm' }) };
    };
    const paragraph = 'The knight walks into the tavern, looks around and orders some ale for his tired friends.';
    const reply = Array.from({ length: 30 }, (_, i) => `${paragraph} (${i})`).join('\n\n');
    const previews = [];
    const out = await translator('model', 'ru', null, null, { onPreview: (text) => previews.push(text) })(reply);
    assert.ok(!/knight/.test(out));
    assert.ok(previews.length >= 1, 'parts were shown before the end');
    const first = previews[0];
    assert.ok(/слово/.test(first) && /knight/.test(first), 'a preview has translated parts and the original of the rest');
    for (const p of previews) assert.equal(p.split('\n\n').length, reply.split('\n\n').length, 'paragraphs keep their places in every preview');
    assert.ok(bodies.length > 1 && bodies.length <= 6 && bodies.every(b => b.text.length <= 1100), `smaller parts: ${bodies.map(b => b.text.length)}`);
    assert.ok(bodies.every(b => b.context === reply), 'each part gets the whole message to read');
    // Without showing as it goes: one request, no context.
    bodies.length = 0;
    n = 0;
    await translator('model', 'ru')(reply);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].context, undefined);
});

test('translate: a part of a long message is translated with the whole message to read', async () => {
    const calls = [];
    const llm = { settings: { models: {} }, complete: async (args) => { calls.push(args); return { text: 'Часть' }; } };
    await translateText(llm, 'Part two.', 'ru', { context: 'Part one.\n\nPart two.' });
    assert.match(calls[0].system, /СООБЩЕНИЕ ЦЕЛИКОМ\nPart one\.\n\nPart two\.\nСООБЩЕНИЕ ЦЕЛИКОМ/);
    assert.match(calls[0].system, /переведи только текст пользователя/);
    await translateText(llm, 'Part two.', 'ru');
    assert.doesNotMatch(calls[1].system, /ЦЕЛИКОМ/);
});

test('translate: free translators show their finished pieces as they go too', async () => {
    const { translator } = await import('../st-extension/translate.js');
    fakeTavern();
    let n = 0;
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        await new Promise(r => setTimeout(r, 30 + 200 * n++));
        return { ok: true, status: 200, text: async () => text.replace(/[A-Za-z]+/g, 'слово') };
    };
    // Lines already in Russian between them: separate pieces.
    const post = 'The knight walks in.\nЛира молчит.\nHe orders ale.\nЛира кивает.\nThen he sits down.';
    const previews = [];
    const out = await translator('google', 'ru', null, null, { onPreview: (t) => previews.push(t) })(post);
    assert.equal(out, 'слово слово слово слово.\nЛира молчит.\nслово слово слово.\nЛира кивает.\nслово слово слово слово.');
    assert.ok(previews.some(p => /слово/.test(p) && /[A-Za-z]{4}/.test(p)), 'a preview mixes finished and waiting pieces');
    assert.ok(previews.every(p => p.split('\n').length === 5));
});
