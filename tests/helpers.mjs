import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { writePngChunks, writeCardJson } from '../plugin/lib/cards.mjs';
import { Store } from '../plugin/lib/store.mjs';

export function tinyPng() {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return writePngChunks([
        { type: 'IHDR', data: ihdr },
        { type: 'IDAT', data: zlib.deflateSync(Buffer.from([0, 10, 20, 30])) },
        { type: 'IEND', data: Buffer.alloc(0) },
    ]);
}

/** A throwaway SillyTavern user folder with one character, one chat and one lorebook. */
export function makeUser({ messages = 8 } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'korrektor-test-'));
    const dirs = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group chats'),
        groups: path.join(root, 'groups'),
        characters: path.join(root, 'characters'),
        worlds: path.join(root, 'worlds'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

    const card = { name: 'Ника', description: 'Глаза серые.', data: { name: 'Ника', description: 'Глаза серые.', extensions: { world: 'Мир' } } };
    fs.writeFileSync(path.join(dirs.characters, 'Nika.png'), writeCardJson(tinyPng(), card));

    const header = { user_name: 'Я', character_name: 'Ника', chat_metadata: { integrity: 'slug-1', note_prompt: '' } };
    const list = Array.from({ length: messages }, (_, i) => ({
        name: i % 2 ? 'Я' : 'Ника',
        is_user: Boolean(i % 2),
        is_system: false,
        mes: `Сообщение ${i}`,
        extra: {},
        swipes: [`Сообщение ${i}`],
        swipe_id: 0,
    }));
    fs.mkdirSync(path.join(dirs.chats, 'Nika'));
    fs.writeFileSync(path.join(dirs.chats, 'Nika', 'chat1.jsonl'), [header, ...list].map(x => JSON.stringify(x)).join('\n'));

    fs.writeFileSync(path.join(dirs.worlds, 'Мир.json'), JSON.stringify({
        entries: {
            0: { uid: 0, key: ['амулет'], content: 'Серебряный амулет.' },
            1: { uid: 1, key: ['город'], content: 'Город у моря.' },
        },
    }));

    const ctx = { handle: 'test', dirs };
    return { ctx, store: new Store(ctx), dirs, chatId: 'c/Nika/chat1', cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function readChatFile(dirs) {
    const lines = fs.readFileSync(path.join(dirs.chats, 'Nika', 'chat1.jsonl'), 'utf8').split('\n').map(l => JSON.parse(l));
    return { header: lines[0], messages: lines.slice(1) };
}

export function readWorldFile(dirs) {
    return JSON.parse(fs.readFileSync(path.join(dirs.worlds, 'Мир.json'), 'utf8'));
}
