import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readCardJson, writeCardJson, readPngChunks, setCardField, getCardField } from '../plugin/lib/cards.mjs';
import { readChat, writeChat, parseChatId, listChats } from '../plugin/lib/chats.mjs';
import { applyOps, inverseOps, restoreBackup } from '../plugin/lib/ops.mjs';
import { addProposals, applyProposal, makeProposal, revertProposal } from '../plugin/lib/proposals.mjs';
import { makeUser, tinyPng, readChatFile, readWorldFile } from './helpers.mjs';

test('card PNG: write then read keeps JSON, image chunks and both text chunks', () => {
    const png = tinyPng();
    const card = { name: 'Тест', data: { name: 'Тест', description: 'Описание с ёлкой' } };
    const out = writeCardJson(png, card);
    assert.equal(readCardJson(out).data.description, 'Описание с ёлкой');
    const types = readPngChunks(out).map(c => c.type);
    assert.deepEqual(types.filter(t => t !== 'tEXt'), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(types.filter(t => t === 'tEXt').length, 2);
    // Writing twice does not pile up text chunks.
    assert.equal(readPngChunks(writeCardJson(out, card)).filter(c => c.type === 'tEXt').length, 2);
});

test('card fields: root mirror and depth prompt', () => {
    const card = { data: { extensions: {} } };
    setCardField(card, 'description', 'А');
    setCardField(card, 'depth_prompt', 'Б');
    assert.equal(card.description, 'А');
    assert.equal(card.data.description, 'А');
    assert.equal(getCardField(card, 'depth_prompt'), 'Б');
});

test('chat ids reject path tricks', () => {
    const { ctx, cleanup } = makeUser();
    try {
        assert.throws(() => parseChatId(ctx, 'c/../x/y'));
        assert.throws(() => parseChatId(ctx, 'c/Nika/../../x'));
        assert.throws(() => parseChatId(ctx, 'g/../x'));
        assert.equal(parseChatId(ctx, 'c/Nika/chat1').file, 'chat1');
    } finally {
        cleanup();
    }
});

test('chat read/write keeps lines and rotates integrity', async () => {
    const { ctx, chatId, dirs, cleanup } = makeUser();
    try {
        const chat = await readChat(ctx, chatId);
        assert.equal(chat.messages.length, 8);
        await writeChat(chat);
        const after = readChatFile(dirs);
        assert.notEqual(after.header.chat_metadata.integrity, 'slug-1');
        assert.equal(after.messages[3].mes, 'Сообщение 3');
        const list = await listChats(ctx);
        assert.equal(list[0].id, chatId);
    } finally {
        cleanup();
    }
});

test('apply ops writes a backup, inverse ops undo exactly', async () => {
    const { ctx, store, chatId, dirs, cleanup } = makeUser();
    try {
        const ops = [
            { op: 'chat.setMessage', chatId, index: 2, before: 'Сообщение 2', after: 'Новое 2' },
            { op: 'chat.setHidden', chatId, indices: [0, 1], before: [false, false], after: [true, true] },
            { op: 'chat.setMeta', chatId, key: 'note_prompt', before: '', after: 'Заметка' },
            { op: 'chat.setMemory', chatId, index: 4, before: '', after: 'Резюме' },
            { op: 'world.addEntry', world: 'Мир', entry: { key: ['море'], content: 'Море холодное.' } },
            { op: 'world.updateEntry', world: 'Мир', uid: 1, before: { content: 'Город у моря.' }, after: { content: 'Портовый город.' } },
            { op: 'world.deleteEntry', world: 'Мир', uid: 0, before: { uid: 0, key: ['амулет'], content: 'Серебряный амулет.' } },
            { op: 'card.setField', avatar: 'Nika.png', field: 'description', before: 'Глаза серые.', after: 'Серые глаза.' },
        ];
        const { backupId, appliedOps } = await applyOps(ctx, store, ops);
        const chat = readChatFile(dirs);
        assert.equal(chat.messages[2].mes, 'Новое 2');
        assert.equal(chat.messages[2].swipes[0], 'Новое 2');
        assert.equal(chat.messages[0].is_system, true);
        assert.equal(chat.header.chat_metadata.note_prompt, 'Заметка');
        assert.equal(chat.messages[4].extra.memory, 'Резюме');
        const world = readWorldFile(dirs);
        assert.equal(Object.keys(world.entries).length, 2);
        assert.equal(world.entries[1].content, 'Портовый город.');
        assert.ok(fs.existsSync(path.join(store.backupPath(backupId), 'manifest.json')));

        // Something new appended to the chat must survive the undo.
        fs.appendFileSync(path.join(dirs.chats, 'Nika', 'chat1.jsonl'), '\n' + JSON.stringify({ name: 'Я', is_user: true, mes: 'Позже' }));
        await applyOps(ctx, store, inverseOps(appliedOps));
        const back = readChatFile(dirs);
        assert.equal(back.messages[2].mes, 'Сообщение 2');
        assert.equal(back.messages[0].is_system, false);
        assert.equal(back.header.chat_metadata.note_prompt, '');
        assert.equal(back.messages[4].extra.memory, undefined);
        assert.equal(back.messages.at(-1).mes, 'Позже');
        const worldBack = readWorldFile(dirs);
        assert.deepEqual(Object.keys(worldBack.entries).sort(), ['0', '1']);
        assert.equal(worldBack.entries[1].content, 'Город у моря.');
    } finally {
        cleanup();
    }
});

test('apply refuses when the file changed since analysis', async () => {
    const { ctx, store, chatId, dirs, cleanup } = makeUser();
    try {
        const before = fs.readFileSync(path.join(dirs.chats, 'Nika', 'chat1.jsonl'), 'utf8');
        await assert.rejects(
            applyOps(ctx, store, [{ op: 'chat.setMessage', chatId, index: 2, before: 'Другой текст', after: 'X' }]),
            (error) => error.status === 409,
        );
        assert.equal(fs.readFileSync(path.join(dirs.chats, 'Nika', 'chat1.jsonl'), 'utf8'), before);
    } finally {
        cleanup();
    }
});

test('message moved by an insert is still found by its text', async () => {
    const { ctx, store, chatId, dirs, cleanup } = makeUser();
    try {
        const file = path.join(dirs.chats, 'Nika', 'chat1.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.splice(1, 0, JSON.stringify({ name: 'Я', is_user: true, mes: 'Вставка' }));
        fs.writeFileSync(file, lines.join('\n'));
        const { appliedOps } = await applyOps(ctx, store, [{ op: 'chat.setMessage', chatId, index: 2, before: 'Сообщение 2', after: 'Новое' }]);
        assert.equal(appliedOps[0].index, 3);
        assert.equal(readChatFile(dirs).messages[3].mes, 'Новое');
    } finally {
        cleanup();
    }
});

test('proposal lifecycle: apply, revert, forced restore', async () => {
    const { ctx, store, chatId, dirs, cleanup } = makeUser();
    try {
        const p = makeProposal({
            kind: 'manual', title: 't', summary: 's', target: { type: 'chat', chatId }, fingerprint: 'f1',
            ops: [{ op: 'chat.setMessage', chatId, index: 2, before: 'Сообщение 2', after: 'Новое' }],
        });
        await addProposals(store, [p]);
        assert.equal((await addProposals(store, [{ ...p, id: 'other' }])).length, 0, 'same fingerprint is not added twice');

        const applied = await applyProposal(ctx, store, p.id, { 0: 'Своими словами' });
        assert.equal(applied.status, 'applied');
        assert.equal(readChatFile(dirs).messages[2].mes, 'Своими словами');

        // The user edits the same message: precise undo is refused, forced restore works.
        const file = path.join(dirs.chats, 'Nika', 'chat1.jsonl');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Своими словами', 'Ещё раз поправлено'));
        await assert.rejects(revertProposal(ctx, store, p.id), (e) => e.status === 409 && e.canForce);
        const reverted = await revertProposal(ctx, store, p.id, { force: true });
        assert.equal(reverted.status, 'reverted');
        assert.equal(readChatFile(dirs).messages[2].mes, 'Сообщение 2');
        // The state before the forced restore is kept too.
        await restoreBackup(ctx, store, reverted.safetyBackupId);
        assert.equal(readChatFile(dirs).messages[2].mes, 'Ещё раз поправлено');
    } finally {
        cleanup();
    }
});
