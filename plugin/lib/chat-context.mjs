import { readChat, findGroupForChat, isVisible, messageText } from './chats.mjs';
import { readCard, cardName, getCardField } from './cards.mjs';
import { readWorld, entriesOf } from './worlds.mjs';
import { connectionInfo, extraCharWorlds, globalWorlds } from './st-settings.mjs';
import { estimateTokens } from './tokens.mjs';
import { uniq } from './util.mjs';
import { charMemoryInfo, readMemories } from './charmemory.mjs';

export const PERMANENT_CARD_FIELDS = ['description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'depth_prompt'];

/** Everything analyzers need to know about one chat. */
export async function buildChatContext(ctx, chatId, stSettings) {
    const chat = await readChat(ctx, chatId);
    const avatars = [];
    let title = chat.folder;
    if (chat.isGroup) {
        const group = await findGroupForChat(ctx, chat.file);
        if (group) {
            avatars.push(...group.members);
            title = group.name;
        }
    } else {
        avatars.push(`${chat.folder}.png`);
    }

    const cards = [];
    for (const avatar of avatars) {
        try {
            const entry = await readCard(ctx, avatar);
            cards.push({ avatar, card: entry.card, name: cardName(entry.card, avatar.replace(/\.png$/i, '')) });
        } catch {
            // Missing card: the chat still gets analyzed.
        }
    }
    if (!chat.isGroup && cards[0]) title = cards[0].name;

    const meta = chat.header?.chat_metadata || {};
    const chatWorld = typeof meta.world_info === 'string' && meta.world_info ? meta.world_info : '';
    const charWorlds = [];
    for (const { avatar, card } of cards) {
        const primary = card?.data?.extensions?.world;
        if (primary) charWorlds.push(primary);
        charWorlds.push(...extraCharWorlds(stSettings, avatar));
    }
    const worldNames = uniq([chatWorld, ...charWorlds, ...globalWorlds(stSettings)].filter(Boolean));

    const worlds = [];
    for (const name of worldNames) {
        try {
            worlds.push(await readWorld(ctx, name));
        } catch {
            // A lorebook mentioned in settings but missing on disk.
        }
    }

    // CharMemory: memories of the (first) character, if that extension is in use.
    const cmInfo = cards[0] ? charMemoryInfo(stSettings, cards[0].avatar) : { installed: false, enabled: false, files: [] };
    const charMemory = { ...cmInfo, memories: cmInfo.enabled && cmInfo.files.length ? await readMemories(ctx, cmInfo) : null };

    return {
        chatId: chat.id,
        chat,
        title,
        charMemory,
        cards,
        chatWorld,
        charWorld: cards[0]?.card?.data?.extensions?.world || '',
        worlds,
        conn: connectionInfo(stSettings),
        stSettings,
        userName: chat.header?.user_name || 'User',
    };
}

export function visibleMessages(chat) {
    return chat.messages.map((message, index) => ({ message, index })).filter(({ message }) => isVisible(message));
}

export function characterMessages(chat) {
    return visibleMessages(chat).filter(({ message }) => !message.is_user);
}

export function latestMemory(chat) {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
        const memory = chat.messages[i]?.extra?.memory;
        if (memory) return { index: i, text: memory };
    }
    return null;
}

export function cardTokens(card) {
    const breakdown = {};
    let total = 0;
    for (const field of PERMANENT_CARD_FIELDS) {
        const tokens = estimateTokens(getCardField(card, field));
        if (tokens) breakdown[field] = tokens;
        total += tokens;
    }
    return { total, breakdown };
}

export function constantEntries(worlds) {
    const result = [];
    for (const world of worlds) {
        for (const entry of entriesOf(world)) {
            if (entry.constant && !entry.disable) result.push({ world: world.name, entry });
        }
    }
    return result;
}

/** Strips markup so text compares by words. */
export function plainText(text) {
    return String(text ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~`#>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function words(text) {
    return plainText(text).toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}']+/gu) ?? [];
}

export function isMostlyCyrillic(text) {
    const value = String(text ?? '');
    const cyr = (value.match(/[Ѐ-ӿ]/g) || []).length;
    const lat = (value.match(/[a-z]/gi) || []).length;
    return cyr > lat;
}

export function chatLanguageIsRussian(chat) {
    const sample = chat.messages.slice(-10).map(messageText).join(' ');
    return isMostlyCyrillic(sample);
}

/** Transcript for model prompts; long messages are cut in the middle. */
export function transcript(chat, indices, { maxCharsPerMessage = 4000 } = {}) {
    return indices.map(i => {
        const message = chat.messages[i];
        let text = plainText(messageText(message));
        if (text.length > maxCharsPerMessage) {
            const half = Math.floor(maxCharsPerMessage / 2);
            text = `${text.slice(0, half)} […] ${text.slice(-half)}`;
        }
        return `[#${i}] ${message.name || (message.is_user ? 'User' : 'Char')}: ${text}`;
    }).join('\n\n');
}
