import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changesToOps, runAsk } from '../plugin/lib/ask.mjs';
import { cleanReport, reportItems, extensionName } from '../plugin/lib/actual.mjs';
import { charMemoryInfo, readMemories } from '../plugin/lib/charmemory.mjs';
import { buildChatContext } from '../plugin/lib/chat-context.mjs';
import { analyzeTokens } from '../plugin/lib/analyzers/tokens.mjs';
import { applyOps } from '../plugin/lib/ops.mjs';
import { DEFAULT_SETTINGS } from '../plugin/lib/store.mjs';
import { makeUser, readChatFile, readWorldFile } from './helpers.mjs';

const settings = () => structuredClone(DEFAULT_SETTINGS);

test('ask: model changes become ops with the current text as "before"; bad ones are skipped', async () => {
    const { ctx, store, chatId, dirs, cleanup } = makeUser();
    try {
        const cc = await buildChatContext(ctx, chatId, {});
        const { ops, skipped } = await changesToOps(ctx, cc, [
            { action: 'edit_message', index: 2, text: 'Новый текст' },
            { action: 'edit_message', index: 99, text: 'нет такого' },
            { action: 'add_entry', world: 'Мир', title: 'Маяк', keys: ['маяк'], content: 'Маяк на мысе.' },
            { action: 'edit_entry', world: 'Мир', uid: 1, content: 'Город у тёплого моря.' },
            { action: 'disable_entry', world: 'Мир', uid: 0 },
            { action: 'edit_card', field: 'description', text: 'Глаза серые, волосы русые.' },
            { action: 'set_note', text: 'Пиши короче' },
            { action: 'format_disk' },
        ], settings());
        assert.deepEqual(ops.map(o => o.op), ['chat.setMessage', 'world.addEntry', 'world.updateEntry', 'world.updateEntry', 'card.setField', 'chat.setMeta']);
        assert.equal(ops[0].before, 'Сообщение 2');
        assert.equal(skipped.length, 2);
        await applyOps(ctx, store, ops);
        assert.equal(readChatFile(dirs).messages[2].mes, 'Новый текст');
        const world = readWorldFile(dirs);
        assert.equal(world.entries[0].disable, true);
        assert.equal(world.entries[1].content, 'Город у тёплого моря.');
        assert.ok(Object.values(world.entries).some(e => e.comment === 'Маяк'));
    } finally {
        cleanup();
    }
});

test('ask: tool call, then final answer; one card with all changes', async () => {
    const { ctx, store, chatId, cleanup } = makeUser();
    try {
        const calls = [];
        const llm = {
            async complete({ messages }) {
                calls.push(messages.length);
                const done = messages.some(m => m.content.startsWith('# Результат search_lorebook'));
                return {
                    model: 'test-model',
                    text: done
                        ? JSON.stringify({ title: 'Уточнить амулет', answer: 'Обновил запись про амулет', changes: [{ action: 'edit_entry', world: 'Мир', uid: 0, content: 'Серебряный амулет с лунным камнем.' }] })
                        : JSON.stringify({ tool: 'search_lorebook', args: { query: 'амулет' } }),
                };
            },
        };
        const logs = [];
        const result = await runAsk(ctx, store, { chatId, request: 'Добавь в запись про амулет лунный камень', llm, stSettings: {}, settings: settings(), log: l => logs.push(l) });
        assert.equal(calls.length, 2);
        assert.ok(logs[0].startsWith('Ищу в лорбуках'));
        const card = (await store.getProposals()).find(p => p.id === result.proposalId);
        assert.equal(card.kind, 'request');
        assert.equal(card.status, 'open');
        assert.equal(card.ops[0].after.content, 'Серебряный амулет с лунным камнем.');

        // A plain question: answer only, no card.
        const ask2 = await runAsk(ctx, store, {
            chatId, request: 'Кто такая Ника?', stSettings: {}, settings: settings(),
            llm: { complete: async () => ({ model: 'm', text: '{"answer": "Ника — персонаж с серыми глазами", "changes": []}' }) },
        });
        assert.equal(ask2.proposalId, null);
        assert.match(ask2.answer, /серыми/);
    } finally {
        cleanup();
    }
});

test('exact report: only numbers and short strings survive; parts sorted', () => {
    const r = cleanReport({
        chatId: 'c/Nika/chat1', total: '12000', maxContext: 16000, model: 'm'.repeat(500),
        parts: { history: 9000, lorebook: 1500, card: -5, evil: 1 },
        extensions: [{ key: '4_vectors_data_bank', tokens: 2400, preview: 'x' }, { key: 'myExt', tokens: 'NaN' }],
        worldInfo: [{ world: 'Мир', uid: 2, label: 'Амулет', tokens: 30 }],
    });
    assert.equal(r.total, 12000);
    assert.equal(r.parts.card, 0);
    assert.equal(r.parts.evil, undefined);
    assert.ok(r.model.length <= 120);
    assert.equal(r.extensions[0].name, 'Data Bank (файлы, CharMemory)');
    assert.equal(r.extensions[1].tokens, 0);
    assert.deepEqual(reportItems(r).map(i => i.key), ['history', 'lorebook']);
    assert.equal(extensionName('customDepthWI_4_0'), 'Лорбук на глубине');
    assert.throws(() => cleanReport({ chatId: '../etc' }));
});

test('CharMemory: memories are read, retrieval off gives advice, heavy injections give advice', async () => {
    const { ctx, chatId, dirs, cleanup } = makeUser();
    try {
        fs.mkdirSync(path.join(dirs.root, 'user', 'files'), { recursive: true });
        fs.writeFileSync(path.join(dirs.root, 'user', 'files', 'Nika-memories.md'), '## Воспоминания\n- Ника боится воды\n- Ника дружит с Кириллом\n');
        const stSettings = {
            extension_settings: {
                charMemory: { enabled: true },
                character_attachments: { 'Nika.png': [{ url: '/user/files/Nika-memories.md', name: 'Nika-memories.md' }, { url: '/user/files/other.txt', name: 'other.txt' }] },
                vectors: { enabled_files: false },
            },
        };
        const info = charMemoryInfo(stSettings, 'Nika.png');
        assert.equal(info.files.length, 1);
        assert.equal(info.retrieval, false);
        assert.equal((await readMemories(ctx, info)).count, 2);

        const cc = await buildChatContext(ctx, chatId, stSettings);
        assert.match(cc.charMemory.memories.text, /боится воды/);
        const actual = cleanReport({ chatId, extensions: [{ key: '4_vectors_data_bank', tokens: 3000, preview: 'Past events' }, { key: '2_floating_prompt', tokens: 5000 }] });
        const found = analyzeTokens(cc, settings(), undefined, actual);
        assert.ok(found.some(p => p.title === 'Воспоминания CharMemory не попадают в промпт'));
        assert.ok(found.some(p => p.title.startsWith('Data Bank')));
        assert.ok(!found.some(p => p.title.startsWith('Заметка автора')), 'the Author\'s Note is the user\'s own text');

        // A path outside the user folder is ignored.
        const evil = charMemoryInfo({ extension_settings: { charMemory: {}, character_attachments: { 'Nika.png': [{ url: '/../../../etc/passwd-memories.md', name: 'x-memories.md' }] } } }, 'Nika.png');
        assert.equal((await readMemories(ctx, evil)).count, 0);
    } finally {
        cleanup();
    }
});
