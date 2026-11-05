import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Android notifications through Termux:API (the "termux-api" package and the Termux:API app).
// Optional: without them the app just shows the cards when opened.

function findCommand(name) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const full = path.join(dir, name);
        try {
            fs.accessSync(full, fs.constants.X_OK);
            return full;
        } catch {
            // keep looking
        }
    }
    return null;
}

export function termuxAvailable() {
    return Boolean(findCommand('termux-notification'));
}

export function notifyTermux({ title, content, url }) {
    const command = findCommand('termux-notification');
    if (!command) return false;
    const args = ['--id', 'korrektor', '--title', title, '--content', content, '--priority', 'default'];
    if (url && /^https?:\/\/[\w.:[\]-]+\/[\w/.-]*$/.test(url)) {
        args.push('--action', `termux-open-url ${url}`);
    }
    execFile(command, args, { timeout: 15000 }, () => { });
    return true;
}
