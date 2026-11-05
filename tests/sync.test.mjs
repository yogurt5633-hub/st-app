import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localManifest, planSync, runSync, cleanName, writeSynced, conflictName } from '../plugin/lib/sync.mjs';

function device(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'korrektor-sync-'));
    for (const [name, text] of Object.entries(files)) {
        const file = path.join(root, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    return root;
}

function setTime(root, name, seconds) {
    fs.utimesSync(path.join(root, ...name.split('/')), seconds, seconds);
}

const read = (root, name) => fs.readFileSync(path.join(root, ...name.split('/')), 'utf8');
const exists = (root, name) => fs.existsSync(path.join(root, ...name.split('/')));

/** The other device, in the same process: what the HTTP client does, without the network. */
function peerOf(root) {
    return {
        device: 'ПК',
        manifest: async () => ({ device: 'ПК', files: await localManifest(root) }),
        get: async (name) => fs.promises.readFile(path.join(root, ...name.split('/'))),
        put: async (name, data, mtime) => writeSynced(root, path.join(root, 'korrektor', 'backups'), name, data, mtime, 'test'),
    };
}

async function sync(phone, pc, now = new Date('2026-11-05T12:00:00')) {
    return runSync({
        root: phone,
        backupsDir: path.join(phone, 'korrektor', 'backups'),
        statePath: path.join(phone, 'korrektor', 'sync-state.json'),
        peer: peerOf(pc),
        peerKey: 'http://pc:8000',
        now,
    });
}

test('sync: only chats, cards, lorebooks and similar; never settings or keys; no tricks with paths', () => {
    assert.equal(cleanName('chats/Ника/chat1.jsonl'), 'chats/Ника/chat1.jsonl');
    assert.equal(cleanName('user/images/Ника/1.png'), 'user/images/Ника/1.png');
    assert.equal(cleanName('settings.json'), null);
    assert.equal(cleanName('secrets.json'), null);
    assert.equal(cleanName('chats/../secrets.json'), null);
    assert.equal(cleanName('/etc/passwd'), null);
    assert.equal(cleanName('chats/.tmp'), null);
    assert.equal(cleanName('korrektor/sync.json'), null);
    assert.match(conflictName('chats/Ника/chat1.jsonl', 'ПК', new Date('2026-11-05T12:30:00')), /^chats\/Ника\/chat1 - копия с ПК 2026-11-05 12-30\.jsonl$/);
    assert.match(conflictName('chats/Ника/chat1.jsonl', 'телефон', new Date('2026-11-05T12:30:00')), /копия с телефона 2026/);
});

test('sync: the first time each side gets what the other has; settings and keys stay', async () => {
    const phone = device({ 'chats/Ника/a.jsonl': 'phone chat', 'settings.json': '{"phone":1}', 'secrets.json': 'sk-phone' });
    const pc = device({ 'chats/Ника/b.jsonl': 'pc chat', 'worlds/Мир.json': '{"entries":{}}', 'settings.json': '{"pc":1}' });
    const result = await sync(phone, pc);
    assert.deepEqual(result.uploaded, ['chats/Ника/a.jsonl']);
    assert.deepEqual(result.downloaded.sort(), ['chats/Ника/b.jsonl', 'worlds/Мир.json']);
    assert.equal(read(pc, 'chats/Ника/a.jsonl'), 'phone chat');
    assert.equal(read(phone, 'chats/Ника/b.jsonl'), 'pc chat');
    assert.equal(read(pc, 'settings.json'), '{"pc":1}');
    assert.equal(exists(pc, 'secrets.json'), false);
    // Second run right away: nothing to do.
    const again = await sync(phone, pc);
    assert.equal(again.uploaded.length + again.downloaded.length + again.conflicts.length, 0);
});

test('sync: a change on one side goes to the other; nothing is deleted', async () => {
    const phone = device({ 'chats/Ника/a.jsonl': 'v1' });
    const pc = device({});
    await sync(phone, pc);
    fs.writeFileSync(path.join(phone, 'chats', 'Ника', 'a.jsonl'), 'v2 from phone');
    setTime(phone, 'chats/Ника/a.jsonl', 2000000000);
    let r = await sync(phone, pc);
    assert.deepEqual(r.uploaded, ['chats/Ника/a.jsonl']);
    assert.equal(read(pc, 'chats/Ника/a.jsonl'), 'v2 from phone');

    fs.writeFileSync(path.join(pc, 'chats', 'Ника', 'a.jsonl'), 'v3 from pc');
    setTime(pc, 'chats/Ника/a.jsonl', 2000000100);
    r = await sync(phone, pc);
    assert.deepEqual(r.downloaded, ['chats/Ника/a.jsonl']);
    assert.equal(read(phone, 'chats/Ника/a.jsonl'), 'v3 from pc');
    // The version it replaced is in the backups.
    const backups = fs.readdirSync(path.join(phone, 'korrektor', 'backups'));
    assert.ok(backups.some(b => b.startsWith('sync-')));

    fs.rmSync(path.join(pc, 'chats', 'Ника', 'a.jsonl'));
    r = await sync(phone, pc);
    assert.ok(exists(phone, 'chats/Ника/a.jsonl'), 'a file deleted on one side is not deleted on the other');
});

test('sync: a chat changed on both sides — the newer stays, the other becomes a separate chat on both devices', async () => {
    const phone = device({ 'chats/Ника/a.jsonl': 'base' });
    const pc = device({});
    await sync(phone, pc);
    fs.writeFileSync(path.join(phone, 'chats', 'Ника', 'a.jsonl'), 'phone wrote more');
    setTime(phone, 'chats/Ника/a.jsonl', 2000000000);
    fs.writeFileSync(path.join(pc, 'chats', 'Ника', 'a.jsonl'), 'pc wrote later');
    setTime(pc, 'chats/Ника/a.jsonl', 2000000500);
    const r = await sync(phone, pc);
    assert.equal(r.conflicts.length, 1);
    const copy = r.conflicts[0].copy;
    assert.match(copy, /копия с /);
    assert.equal(read(phone, 'chats/Ника/a.jsonl'), 'pc wrote later');
    assert.equal(read(pc, 'chats/Ника/a.jsonl'), 'pc wrote later');
    assert.equal(read(phone, copy), 'phone wrote more');
    assert.equal(read(pc, copy), 'phone wrote more');
    const again = await sync(phone, pc);
    assert.equal(again.uploaded.length + again.downloaded.length + again.conflicts.length, 0);
});

test('sync plan: without a past sync, different files with the same name are a conflict', () => {
    const plan = planSync({ 'chats/x/a.jsonl': { size: 5, mtime: 100 } }, { 'chats/x/a.jsonl': { size: 7, mtime: 200 } }, {});
    assert.deepEqual(plan, [{ name: 'chats/x/a.jsonl', action: 'conflict', newer: 'remote' }]);
});

test('sync: the same file with other dates (default files of both installs) is not a conflict', async () => {
    const phone = device({ 'backgrounds/a.jpg': 'same bytes', 'characters/default.png': 'card' });
    const pc = device({ 'backgrounds/a.jpg': 'same bytes', 'characters/default.png': 'card' });
    setTime(phone, 'backgrounds/a.jpg', 1900000000);
    setTime(pc, 'backgrounds/a.jpg', 2000000000);
    const r = await sync(phone, pc);
    assert.equal(r.conflicts.length, 0);
    const again = await sync(phone, pc);
    assert.equal(again.uploaded.length + again.downloaded.length + again.conflicts.length, 0);
});
