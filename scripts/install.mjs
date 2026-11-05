#!/usr/bin/env node
// Installs Korrektor into SillyTavern on a computer (Windows, macOS, Linux).
// Node is already there: SillyTavern runs on it.
//
//   node scripts/install.mjs "C:\path\to\SillyTavern"
//   node scripts/install.mjs ~/SillyTavern
//
// Copies the plugin to SillyTavern/plugins/korrektor, the companion extension to
// data/<user>/extensions/korrektor-sync and turns on enableServerPlugins in config.yaml.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const say = (text = '') => console.log(text);

function isSillyTavern(dir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return fs.existsSync(path.join(dir, 'server.js')) && String(pkg.name).toLowerCase() === 'sillytavern';
    } catch {
        return false;
    }
}

function findSillyTavern() {
    const given = process.argv[2] || process.env.ST_DIR;
    if (given) return path.resolve(given.replace(/^~(?=$|[\\/])/, os.homedir()));
    const candidates = [
        process.cwd(),
        path.join(process.cwd(), 'SillyTavern'),
        path.join(REPO, '..', 'SillyTavern'),
        path.join(os.homedir(), 'SillyTavern'),
        path.join(os.homedir(), 'SillyTavern-Launcher', 'SillyTavern'),
        path.join(os.homedir(), 'Desktop', 'SillyTavern'),
        path.join(os.homedir(), 'Documents', 'SillyTavern'),
    ];
    return candidates.find(isSillyTavern) || '';
}

const stDir = findSillyTavern();
if (!stDir || !isSillyTavern(stDir)) {
    say(`Не нашёл SillyTavern${stDir ? ` в ${stDir}` : ''}.`);
    say('Укажите папку: node scripts/install.mjs "путь\\к\\SillyTavern"');
    process.exit(1);
}
say(`SillyTavern: ${stDir}`);

// 1. Plugin: copied next to its place, then renamed in one step.
const pluginsDir = path.join(stDir, 'plugins');
const target = path.join(pluginsDir, 'korrektor');
const temp = path.join(pluginsDir, '.korrektor-new');
fs.mkdirSync(pluginsDir, { recursive: true });
fs.rmSync(temp, { recursive: true, force: true });
fs.cpSync(path.join(REPO, 'plugin'), temp, { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(temp, target);
const version = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version;
say(`Плагин Корректор ${version} скопирован в ${target}`);

// 2. Companion extension for every SillyTavern user that already exists.
const dataDir = path.join(stDir, 'data');
let users = 0;
for (const name of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
    const userDir = path.join(dataDir, name);
    if (!fs.existsSync(path.join(userDir, 'settings.json'))) continue;
    const ext = path.join(userDir, 'extensions', 'korrektor-sync');
    fs.rmSync(ext, { recursive: true, force: true });
    fs.cpSync(path.join(REPO, 'st-extension'), ext, { recursive: true });
    users++;
}
say(users ? `Расширение «Корректор» установлено (пользователей: ${users})` : 'Пользователей SillyTavern ещё нет: запустите таверну один раз и повторите установку, чтобы поставить расширение');

// 3. config.yaml: server plugins on.
const config = path.join(stDir, 'config.yaml');
if (!fs.existsSync(config) && fs.existsSync(path.join(stDir, 'default', 'config.yaml'))) {
    fs.copyFileSync(path.join(stDir, 'default', 'config.yaml'), config);
}
if (fs.existsSync(config)) {
    let text = fs.readFileSync(config, 'utf8');
    text = /^enableServerPlugins:/m.test(text) ? text.replace(/^enableServerPlugins:.*$/m, 'enableServerPlugins: true') : `${text.trimEnd()}\nenableServerPlugins: true\n`;
    fs.writeFileSync(config, text);
    say('В config.yaml включено enableServerPlugins: true');
    const listen = /^listen:\s*true/m.test(text);
    say();
    say('Готово. Перезапустите SillyTavern.');
    say();
    say('Чтобы связать эту таверну с телефоном (Корректор → Ещё → Связь с ПК):');
    if (!listen) say('  • в config.yaml поставьте listen: true — иначе таверна не видна в сети;');
    say('  • и одно из двух: добавьте адрес телефона в whitelist, либо whitelistMode: false и basicAuthMode: true с логином и паролем;');
    say('  • на телефоне впишите адрес этого компьютера: http://IP-компьютера:8000 (в той же Wi‑Fi) или его адрес в Tailscale.');
} else {
    say('config.yaml не найден: запустите SillyTavern один раз и повторите установку');
    process.exit(1);
}
