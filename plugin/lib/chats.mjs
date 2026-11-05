import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpError, plainName, safeJoin, sha256, writeFileAtomic } from './util.mjs';

/**
 * Chat ids used by the app:
 *   c/<character folder>/<file name without .jsonl>  - character chat
 *   g/<group chat id>                                - group chat
 */
export function encodeChatId(chat) {
    return chat.isGroup ? `g/${chat.file}` : `c/${chat.folder}/${chat.file}`;
}

export function parseChatId(ctx, chatId) {
    const value = String(chatId ?? '');
    if (value.startsWith('g/')) {
        const file = plainName(value.slice(2));
        return {
            isGroup: true,
            file,
            folder: null,
            path: safeJoin(ctx.dirs.groupChats, `${file}.jsonl`),
        };
    }
    if (value.startsWith('c/')) {
        const rest = value.slice(2);
        const slash = rest.indexOf('/');
        if (slash < 1) throw httpError(400, 'Неверный id чата');
        const folder = plainName(rest.slice(0, slash));
        const file = plainName(rest.slice(slash + 1));
        return {
            isGroup: false,
            file,
            folder,
            path: safeJoin(ctx.dirs.chats, folder, `${file}.jsonl`),
        };
    }
    throw httpError(400, 'Неверный id чата');
}

function isHeader(line) {
    return line && typeof line === 'object' && !Array.isArray(line)
        && !('mes' in line) && ('chat_metadata' in line || 'user_name' in line || 'character_name' in line);
}

/** Reads a .jsonl chat. Lines that do not parse are kept verbatim so nothing is lost on save. */
export async function readChat(ctx, chatId) {
    const ref = parseChatId(ctx, chatId);
    let raw;
    try {
        raw = await fs.promises.readFile(ref.path, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') throw httpError(404, 'Чат не найден');
        throw error;
    }
    const lines = raw.replace(/^﻿/, '').split('\n').filter(line => line.trim().length > 0);
    const parsed = lines.map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return { __raw: line };
        }
    });
    let header = null;
    if (parsed.length && isHeader(parsed[0])) {
        header = parsed.shift();
    }
    return {
        id: encodeChatId(ref),
        ...ref,
        header,
        messages: parsed,
        hash: sha256(raw),
        raw,
    };
}

export function serializeChat(chat) {
    const lines = [];
    if (chat.header) lines.push(JSON.stringify(chat.header));
    for (const message of chat.messages) {
        lines.push(message && message.__raw !== undefined ? message.__raw : JSON.stringify(message));
    }
    return lines.join('\n');
}

/**
 * Saves a chat. A fresh integrity slug makes an open SillyTavern tab notice
 * the change on its next save instead of silently overwriting it.
 */
export async function writeChat(chat) {
    if (chat.header) {
        chat.header.chat_metadata = chat.header.chat_metadata || {};
        chat.header.chat_metadata.integrity = crypto.randomUUID();
    }
    const data = serializeChat(chat);
    await writeFileAtomic(chat.path, data);
    return sha256(data);
}

export function messageText(message) {
    return typeof message?.mes === 'string' ? message.mes : '';
}

/** Sets message text and keeps the active swipe in sync, like SillyTavern does on edit. */
export function setMessageText(message, text) {
    message.mes = text;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipe_id < message.swipes.length) {
        message.swipes[message.swipe_id] = text;
    }
}

export function isVisible(message) {
    return message && message.__raw === undefined && !message.is_system;
}

async function statSafe(file) {
    try {
        return await fs.promises.stat(file);
    } catch {
        return null;
    }
}

async function readDirSafe(dir) {
    try {
        return await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

/** Lists character and group chats, newest first. */
export async function listChats(ctx) {
    const result = [];
    for (const folderEntry of await readDirSafe(ctx.dirs.chats)) {
        if (!folderEntry.isDirectory()) continue;
        const folder = folderEntry.name;
        const dir = path.join(ctx.dirs.chats, folder);
        for (const entry of await readDirSafe(dir)) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const stat = await statSafe(path.join(dir, entry.name));
            if (!stat) continue;
            const file = entry.name.slice(0, -'.jsonl'.length);
            result.push({
                id: `c/${folder}/${file}`,
                isGroup: false,
                folder,
                file,
                avatar: `${folder}.png`,
                title: folder,
                size: stat.size,
                mtime: stat.mtimeMs,
            });
        }
    }

    const groups = await listGroups(ctx);
    for (const group of groups) {
        for (const chatFile of group.chats) {
            const file = path.join(ctx.dirs.groupChats, `${chatFile}.jsonl`);
            const stat = await statSafe(file);
            if (!stat) continue;
            result.push({
                id: `g/${chatFile}`,
                isGroup: true,
                folder: null,
                file: chatFile,
                groupId: group.id,
                members: group.members,
                title: group.name,
                size: stat.size,
                mtime: stat.mtimeMs,
            });
        }
    }

    result.sort((a, b) => b.mtime - a.mtime);
    return result;
}

export async function listGroups(ctx) {
    const groups = [];
    for (const entry of await readDirSafe(ctx.dirs.groups)) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
            const data = JSON.parse(await fs.promises.readFile(path.join(ctx.dirs.groups, entry.name), 'utf8'));
            groups.push({
                id: data.id ?? entry.name.slice(0, -5),
                name: data.name ?? entry.name.slice(0, -5),
                members: Array.isArray(data.members) ? data.members : [],
                chats: Array.isArray(data.chats) ? data.chats : [],
            });
        } catch {
            // A broken group file is not our business.
        }
    }
    return groups;
}

/** Finds the group a group chat belongs to. */
export async function findGroupForChat(ctx, file) {
    const groups = await listGroups(ctx);
    return groups.find(group => group.chats.includes(file)) ?? null;
}
