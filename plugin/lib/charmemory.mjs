import fs from 'node:fs';
import path from 'node:path';
import { isInside, truncate } from './util.mjs';

// CharMemory (github.com/bal-spec/sillytavern-character-memory) keeps memories
// as markdown files in the character's Data Bank; Vector Storage brings the
// relevant ones into the prompt. Korrektor only reads these files: as known
// facts (so it does not suggest them again) and for token advice.

function isDisabled(stSettings) {
    const list = stSettings?.extension_settings?.disabledExtensions;
    return Array.isArray(list) && list.some(name => /character-memory|charmemory/i.test(String(name)));
}

export function charMemoryInfo(stSettings, avatar) {
    const ext = stSettings?.extension_settings || {};
    const settings = ext.charMemory;
    if (!settings || typeof settings !== 'object') return { installed: false, enabled: false, files: [] };
    const attachments = Array.isArray(ext.character_attachments?.[avatar]) ? ext.character_attachments[avatar] : [];
    const custom = typeof settings.fileName === 'string' && settings.fileName ? settings.fileName : null;
    const files = attachments.filter(a => a && typeof a.url === 'string' && (/-memories\.md$/i.test(a.name || '') || (custom && a.name === custom)));
    const vectorsOff = Array.isArray(ext.disabledExtensions) && ext.disabledExtensions.includes('vectors');
    return {
        installed: true,
        enabled: settings.enabled !== false && !isDisabled(stSettings),
        files: files.map(f => ({ name: f.name, url: f.url })),
        // Without Vector Storage for files the memories are stored but never reach the model.
        retrieval: Boolean(ext.vectors?.enabled_files) && !vectorsOff,
    };
}

/** Text of the memory files (bullets), capped. */
export async function readMemories(ctx, info, maxChars = 12000) {
    const parts = [];
    for (const file of info.files || []) {
        const full = path.join(ctx.dirs.root, file.url);
        if (!isInside(ctx.dirs.root, full)) continue;
        try {
            parts.push(await fs.promises.readFile(full, 'utf8'));
        } catch {
            // file listed but missing on disk
        }
    }
    const text = parts.join('\n\n');
    return { text: truncate(text, maxChars), count: (text.match(/^\s*[-*]\s+\S/gm) || []).length };
}
