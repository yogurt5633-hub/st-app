import fs from 'node:fs';
import { httpError, plainName, safeJoin, sha256, writeFileAtomic } from './util.mjs';

// Character cards are PNG files with the card JSON (base64) in tEXt chunks:
// 'chara' holds V2, 'ccv3' holds V3. SillyTavern reads ccv3 first and writes both.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffers) {
    let crc = 0xffffffff;
    for (const buf of buffers) {
        for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function readPngChunks(buffer) {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw httpError(422, 'Файл карточки не похож на PNG');
    }
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        chunks.push({ type, data });
        offset += 12 + length;
        if (type === 'IEND') break;
    }
    return chunks;
}

export function writePngChunks(chunks) {
    const parts = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(chunk.data.length, 0);
        head.write(chunk.type, 4, 'latin1');
        const typeBuf = head.subarray(4, 8);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32([typeBuf, chunk.data]), 0);
        parts.push(head, chunk.data, crc);
    }
    return Buffer.concat(parts);
}

function decodeText(data) {
    const zero = data.indexOf(0);
    if (zero < 0) return null;
    return { keyword: data.toString('latin1', 0, zero), text: data.toString('latin1', zero + 1) };
}

function encodeText(keyword, text) {
    return { type: 'tEXt', data: Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]) };
}

export function readCardJson(buffer) {
    const texts = readPngChunks(buffer).filter(c => c.type === 'tEXt').map(c => decodeText(c.data)).filter(Boolean);
    const pick = texts.find(t => t.keyword.toLowerCase() === 'ccv3') ?? texts.find(t => t.keyword.toLowerCase() === 'chara');
    if (!pick) throw httpError(422, 'В PNG нет данных карточки');
    return JSON.parse(Buffer.from(pick.text, 'base64').toString('utf8'));
}

export function writeCardJson(buffer, card) {
    const chunks = readPngChunks(buffer).filter(chunk => {
        if (chunk.type !== 'tEXt') return true;
        const text = decodeText(chunk.data);
        const key = text?.keyword.toLowerCase();
        return key !== 'chara' && key !== 'ccv3';
    });
    const v2 = { ...card, spec: 'chara_card_v2', spec_version: '2.0' };
    const v3 = { ...card, spec: 'chara_card_v3', spec_version: '3.0' };
    const iend = chunks.findIndex(c => c.type === 'IEND');
    const insertAt = iend < 0 ? chunks.length : iend;
    chunks.splice(insertAt, 0,
        encodeText('chara', Buffer.from(JSON.stringify(v2), 'utf8').toString('base64')),
        encodeText('ccv3', Buffer.from(JSON.stringify(v3), 'utf8').toString('base64')));
    return writePngChunks(chunks);
}

// Fields the assistant may edit. Root copies exist for V1 compatibility.
export const CARD_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'depth_prompt'];
const ROOT_MIRROR = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];

export function getCardField(card, field) {
    if (field === 'depth_prompt') return card?.data?.extensions?.depth_prompt?.prompt ?? '';
    return card?.data?.[field] ?? card?.[field] ?? '';
}

export function setCardField(card, field, value) {
    card.data = card.data || {};
    if (field === 'depth_prompt') {
        card.data.extensions = card.data.extensions || {};
        card.data.extensions.depth_prompt = { depth: 4, role: 'system', ...(card.data.extensions.depth_prompt || {}), prompt: value };
        return;
    }
    card.data[field] = value;
    if (ROOT_MIRROR.includes(field)) card[field] = value;
    if (field === 'creator_notes') card.creatorcomment = value;
}

export function cardPath(ctx, avatar) {
    const name = plainName(avatar);
    if (!name.toLowerCase().endsWith('.png')) throw httpError(400, 'Нужно имя PNG-файла карточки');
    return safeJoin(ctx.dirs.characters, name);
}

export async function readCard(ctx, avatar) {
    const file = cardPath(ctx, avatar);
    let buffer;
    try {
        buffer = await fs.promises.readFile(file);
    } catch (error) {
        if (error.code === 'ENOENT') throw httpError(404, 'Карточка не найдена');
        throw error;
    }
    return { avatar, path: file, buffer, hash: sha256(buffer), card: readCardJson(buffer) };
}

export async function writeCard(entry) {
    const out = writeCardJson(entry.buffer, entry.card);
    await writeFileAtomic(entry.path, out);
    return sha256(out);
}

export function cardName(card, fallback = '') {
    return card?.data?.name || card?.name || fallback;
}

export async function listCards(ctx) {
    let entries = [];
    try {
        entries = await fs.promises.readdir(ctx.dirs.characters, { withFileTypes: true });
    } catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
        try {
            const { card } = await readCard(ctx, entry.name);
            result.push({ avatar: entry.name, name: cardName(card, entry.name.slice(0, -4)), world: card?.data?.extensions?.world || '' });
        } catch {
            // Not a card or unreadable: skip.
        }
    }
    return result;
}
