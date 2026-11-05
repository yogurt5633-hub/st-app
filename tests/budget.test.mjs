import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { simulateWorldInfo, presetPrompts, promptBudget, markupTokens } from '../plugin/lib/prompt-budget.mjs';
import { analyzeTokens, HTML_REGEX_NAME } from '../plugin/lib/analyzers/tokens.mjs';
import { applyOps, inverseOps } from '../plugin/lib/ops.mjs';
import { DEFAULT_SETTINGS } from '../plugin/lib/store.mjs';
import { runScan } from '../plugin/lib/scanner.mjs';
import { makeUser } from './helpers.mjs';

const msg = (name, mes, extra = {}) => ({ name, is_user: name === 'Я', is_system: false, mes, extra: {}, ...extra });
const chatOf = (...messages) => ({ header: { chat_metadata: {} }, messages });
const world = (name, entries) => ({ name, data: { entries: Object.fromEntries(entries.map((e, i) => [i, { uid: i, ...e }])) } });

test('lorebook: keys in recent messages, scan depth, whole words like SillyTavern', () => {
    const chat = chatOf(msg('Я', 'Про амулет давно забыли'), msg('Ника', 'Пошли в порт'), msg('Я', 'Встретим Кириллу?'));
    const wi = simulateWorldInfo({
        chat,
        stSettings: { world_info_settings: { world_info_depth: 2 } },
        worlds: [world('Мир', [
            { key: ['амулет'], content: 'Амулет серебряный' },
            { key: ['порт'], content: 'Порт закрыт ночью' },
            { key: ['кирилл'], content: 'Кирилл — капитан' },
            { key: ['море'], content: 'Не сработает' },
            { key: [], constant: true, content: 'Всегда в промпте' },
        ])],
    });
    const labels = wi.included.map(x => x.entry.content).sort();
    // "амулет" is three messages back, outside depth 2.
    assert.deepEqual(labels, ['Всегда в промпте', 'Кирилл — капитан', 'Порт закрыт ночью'].sort());
});

test('lorebook: secondary keys, recursion, inclusion groups and budget', () => {
    const chat = chatOf(msg('Я', 'Идём к капитану'));
    const wi = simulateWorldInfo({
        chat,
        contextSize: 1000,
        stSettings: { world_info_settings: { world_info_depth: 2, world_info_budget: 10 } },
        worlds: [world('Мир', [
            { key: ['капитан'], content: 'Капитан служит в гильдии' },
            { key: ['гильдии'], content: 'Гильдия правит портом' }, // only through recursion
            { key: ['капитан'], keysecondary: ['дракон'], selective: true, selectiveLogic: 0, content: 'Нужен ещё дракон' },
            { key: ['капитан'], group: 'g', order: 10, content: 'Слабая версия' },
            { key: ['капитан'], group: 'g', order: 90, content: 'Сильная версия' },
            { key: ['капитан'], content: 'Очень длинная запись '.repeat(40) },
        ])],
    });
    const inside = wi.included.map(x => x.entry.content);
    assert.ok(inside.includes('Гильдия правит портом'));
    assert.ok(!inside.includes('Нужен ещё дракон'));
    assert.ok(inside.includes('Сильная версия') && !inside.includes('Слабая версия'));
    assert.ok(wi.dropped.some(x => x.why === 'budget'), 'the long entry does not fit 10% of 1000 tokens');
});

test('preset: only enabled prompts with text, in the global order', () => {
    const st = {
        oai_settings: {
            prompts: [
                { identifier: 'main', name: 'Main', content: 'Пиши хорошо' },
                { identifier: 'jb', name: 'JB', content: 'Длинный джейлбрейк' },
                { identifier: 'off', name: 'Off', content: 'Выключен' },
                { identifier: 'chatHistory', name: 'History', marker: true },
            ],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'jb', enabled: true }, { identifier: 'off', enabled: false }, { identifier: 'chatHistory', enabled: true }] }],
        },
    };
    assert.deepEqual(presetPrompts(st).map(p => p.identifier), ['main', 'jb']);
});

test('markup tokens count tags and styles, not the text inside', () => {
    assert.equal(markupTokens('просто текст'), 0);
    assert.ok(markupTokens('<div style="color:red;border:1px solid"><b>HP</b>: 10</div><style>.a{color:red}</style>') > 10);
});

function tokenUser() {
    const user = makeUser({ messages: 6 });
    const { dirs, chatId } = user;
    const settings = {
        main_api: 'openai',
        oai_settings: {
            chat_completion_source: 'openrouter', openrouter_model: 'x', openai_max_context: 8000, openai_max_tokens: 500,
            preset_settings_openai: 'Мой пресет',
            prompts: [{ identifier: 'main', name: 'Main', content: 'Правило. '.repeat(400) }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        },
        power_user: { reasoning: { add_to_prompts: true, max_additions: 2 } },
        extension_settings: { regex: [], disabledExtensions: [] },
        world_info_settings: { world_info_depth: 2 },
    };
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify(settings));
    // HTML-heavy replies with stored reasoning
    const file = path.join(dirs.chats, 'Nika', 'chat1.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => JSON.parse(l));
    for (const m of lines.slice(1)) {
        if (m.is_user) continue;
        m.mes = `<div class="status" style="border:1px solid #333;padding:4px;color:#eee;font-family:monospace">${'<span style="color:#f80">HP</span> 10 '.repeat(30)}</div> Ника кивает.`;
        m.extra = { reasoning: 'Подумаю, что ответить. '.repeat(40) };
    }
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
    return { ...user, settings, chatId };
}

test('token audit finds heavy preset prompt, reasoning in prompt and HTML; settings fixes apply and undo', async () => {
    const { ctx, store, dirs, chatId, cleanup } = tokenUser();
    try {
        const { buildChatContext } = await import('../plugin/lib/chat-context.mjs');
        const stSettings = JSON.parse(fs.readFileSync(path.join(dirs.root, 'settings.json'), 'utf8'));
        const cc = await buildChatContext(ctx, chatId, stSettings);
        const found = analyzeTokens(cc, structuredClone(DEFAULT_SETTINGS));
        const kinds = found.map(p => p.kind);
        assert.ok(kinds.includes('preset_bloat'));
        assert.ok(kinds.includes('prompt_reasoning'));
        assert.ok(kinds.includes('prompt_html'));

        const html = found.find(p => p.kind === 'prompt_html');
        const reasoning = found.find(p => p.kind === 'prompt_reasoning');
        const { appliedOps } = await applyOps(ctx, store, [...html.ops, ...reasoning.ops]);
        let saved = JSON.parse(fs.readFileSync(path.join(dirs.root, 'settings.json'), 'utf8'));
        assert.equal(saved.power_user.reasoning.add_to_prompts, false);
        assert.equal(saved.extension_settings.regex[0].scriptName, HTML_REGEX_NAME);

        // With the regex in place the estimate drops the markup of older replies.
        const after = promptBudget(await buildChatContext(ctx, chatId, saved), saved);
        const before = promptBudget(cc, stSettings);
        assert.ok(after.total < before.total);

        await applyOps(ctx, store, inverseOps(appliedOps));
        saved = JSON.parse(fs.readFileSync(path.join(dirs.root, 'settings.json'), 'utf8'));
        assert.equal(saved.power_user.reasoning.add_to_prompts, true);
        assert.deepEqual(saved.extension_settings.regex, []);
    } finally {
        cleanup();
    }
});

test('settings op refuses when the value changed in SillyTavern meanwhile', async () => {
    const { ctx, store, dirs, cleanup } = tokenUser();
    try {
        // SillyTavern now has true, the card expected 'другое': refuse.
        const op = { op: 'settings.setPath', path: ['power_user', 'reasoning', 'add_to_prompts'], before: 'другое', after: false };
        await assert.rejects(applyOps(ctx, store, [op]), e => e.status === 409);
        const presetOp = { op: 'settings.setPath', path: ['oai_settings', 'prompts', { key: 'identifier', value: 'main' }, 'content'], before: 'Правило. '.repeat(400), after: 'Коротко' };
        await applyOps(ctx, store, [presetOp]);
        const saved = JSON.parse(fs.readFileSync(path.join(dirs.root, 'settings.json'), 'utf8'));
        assert.equal(saved.oai_settings.prompts[0].content, 'Коротко');
    } finally {
        cleanup();
    }
});

test('scan in "watched" mode checks only the marked chats and links cards to them', async () => {
    const { ctx, store, chatId, cleanup } = tokenUser();
    try {
        await store.saveSettings({ scan: { mode: 'watched', watched: [] } });
        const none = await runScan(ctx, store, {});
        assert.equal(none.chats, 0);
        await store.saveSettings({ scan: { watched: [chatId] } });
        const one = await runScan(ctx, store, {});
        assert.equal(one.chats, 1);
        const items = await store.getProposals();
        assert.ok(items.length > 0 && items.every(p => p.chats?.includes(chatId)));
    } finally {
        cleanup();
    }
});
