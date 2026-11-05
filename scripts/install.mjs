#!/usr/bin/env node
// Installs Korrektor into SillyTavern on a computer (Windows, macOS, Linux).
// Node is already there: SillyTavern runs on it.
//
//   node scripts/install.mjs "C:\path\to\SillyTavern"
//   node scripts/install.mjs ~/SillyTavern
//
// Copies the plugin to SillyTavern/plugins/korrektor, the companion extension to
// data/<user>/extensions/korrektor-sync and turns on enableServerPlugins in config.yaml.
//
// No fs.cpSync: on Windows it fails with EIO / "Access is denied" on some
// Node versions and folders. Files are copied one by one, with retries.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const say = (text = '') => console.log(text);
const isWindows = process.platform === 'win32';

function pause(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Antivirus, the search indexer or an open Explorer window hold files on Windows for a moment. */
function retry(what, fn) {
    let last;
    for (let i = 0; i < 6; i++) {
        try {
            return fn();
        } catch (error) {
            last = error;
            if (!['EBUSY', 'EPERM', 'EACCES', 'EIO', 'ENOTEMPTY', 'EMFILE'].includes(error.code)) break;
            pause(250 * (i + 1));
        }
    }
    last.message = `${what}: ${last.message}`;
    throw last;
}

function copyDir(from, to) {
    retry(`папка ${to}`, () => fs.mkdirSync(to, { recursive: true }));
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else if (entry.isFile()) retry(`файл ${dst}`, () => fs.writeFileSync(dst, fs.readFileSync(src)));
    }
}

function removeDir(dir) {
    if (!fs.existsSync(dir)) return;
    retry(`удаление ${dir}`, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
}

/**
 * Puts a fresh copy of `from` at `to`. First into a temporary folder next to it,
 * then one rename, so a half-copied plugin never stays. If Windows refuses the
 * rename, the files are written straight over the old ones.
 */
function replaceDir(from, to, temp = `${to}.new-${process.pid}`) {
    try {
        removeDir(temp);
        copyDir(from, temp);
        removeDir(to);
        retry(`переименование в ${to}`, () => fs.renameSync(temp, to));
    } catch (error) {
        try { removeDir(temp); } catch { /* left for the next run */ }
        if (fs.existsSync(path.join(to, 'package.json')) || !fs.existsSync(to)) {
            copyDir(from, to);
            return;
        }
        throw error;
    }
}

function explain(error) {
    say();
    say(`Ошибка: ${error.message}`);
    say();
    if (['EIO', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        say('Windows не дал записать файлы. Что помогает:');
        say('  1. Закройте SillyTavern (окно с чёрной консолью) и запустите установку ещё раз.');
        say('  2. Закройте окна Проводника, открытые в папке SillyTavern.');
        say('  3. Если папка в OneDrive или «Документах» — защита Windows может блокировать запись:');
        say('     Параметры → Безопасность Windows → Защита от вирусов → Управление защитой от программ-шантажистов →');
        say('     «Контролируемый доступ к папкам»: выключите или разрешите node.exe.');
        say('  4. Или запустите командную строку от имени администратора и повторите команду.');
    } else if (error.code === 'ENOSPC') {
        say('На диске закончилось место.');
    }
    say();
    say('Подробный гайд: https://github.com/yogurt5633-hub/st-app/blob/main/docs/GUIDE.md');
    process.exit(1);
}

function isSillyTavern(dir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return fs.existsSync(path.join(dir, 'server.js')) && String(pkg.name).toLowerCase() === 'sillytavern';
    } catch {
        return false;
    }
}

function findSillyTavern() {
    const given = (process.argv[2] || process.env.ST_DIR || '').trim().replace(/^["']|["']$/g, '');
    if (given) return path.resolve(given.replace(/^~(?=$|[\\/])/, os.homedir()));
    const home = os.homedir();
    const candidates = [
        process.cwd(),
        path.join(process.cwd(), 'SillyTavern'),
        path.join(REPO, '..', 'SillyTavern'),
        path.join(home, 'SillyTavern'),
        path.join(home, 'SillyTavern-Launcher', 'SillyTavern'),
        path.join(home, 'Desktop', 'SillyTavern'),
        path.join(home, 'Documents', 'SillyTavern'),
        path.join(home, 'OneDrive', 'Desktop', 'SillyTavern'),
        path.join(home, 'OneDrive', 'Documents', 'SillyTavern'),
    ];
    if (isWindows) for (const drive of ['C:', 'D:', 'E:']) {
        candidates.push(path.join(`${drive}\\`, 'SillyTavern'), path.join(`${drive}\\`, 'SillyTavern-Launcher', 'SillyTavern'));
    }
    return candidates.find(isSillyTavern) || '';
}

const stDir = findSillyTavern();
if (!stDir || !isSillyTavern(stDir)) {
    say(`Не нашёл SillyTavern${stDir ? ` в ${stDir}` : ''}.`);
    say('Укажите папку, где лежит server.js, в кавычках:');
    say(isWindows ? '  node scripts\\install.mjs "D:\\SillyTavern"' : '  node scripts/install.mjs ~/SillyTavern');
    process.exit(1);
}
say(`SillyTavern: ${stDir}`);

try {
    // 1. Plugin.
    const pluginsDir = path.join(stDir, 'plugins');
    const target = path.join(pluginsDir, 'korrektor');
    retry('папка plugins', () => fs.mkdirSync(pluginsDir, { recursive: true }));
    // Leftovers of older installers: a folder in plugins/ that is not a plugin breaks nothing, but is clutter.
    for (const old of ['.korrektor-new']) removeDir(path.join(pluginsDir, old));
    for (const name of fs.readdirSync(stDir)) {
        if (/^\.korrektor-install-\d+$/.test(name)) removeDir(path.join(stDir, name));
    }
    // The temporary copy goes to the SillyTavern folder itself: same disk, and not in plugins/, where it would be loaded.
    replaceDir(path.join(REPO, 'plugin'), target, path.join(stDir, `.korrektor-install-${process.pid}`));
    const version = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version;
    say(`Плагин Корректор ${version} скопирован в ${target}`);

    // 2. Companion extension for every SillyTavern user that already exists.
    const dataDir = path.join(stDir, 'data');
    let users = 0;
    for (const name of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
        const userDir = path.join(dataDir, name);
        if (!fs.existsSync(path.join(userDir, 'settings.json'))) continue;
        const extDir = path.join(userDir, 'extensions');
        retry('папка extensions', () => fs.mkdirSync(extDir, { recursive: true }));
        for (const entry of fs.readdirSync(extDir)) {
            if (/^korrektor-sync\.new-\d+$/.test(entry)) removeDir(path.join(extDir, entry));
        }
        replaceDir(path.join(REPO, 'st-extension'), path.join(extDir, 'korrektor-sync'));
        users++;
    }
    say(users ? `Расширение «Корректор» установлено (пользователей: ${users})` : 'Пользователей SillyTavern ещё нет: запустите таверну один раз и повторите установку, чтобы поставить расширение');

    // 3. config.yaml: server plugins on.
    const config = path.join(stDir, 'config.yaml');
    if (!fs.existsSync(config) && fs.existsSync(path.join(stDir, 'default', 'config.yaml'))) {
        retry('config.yaml', () => fs.copyFileSync(path.join(stDir, 'default', 'config.yaml'), config));
    }
    if (!fs.existsSync(config)) {
        say('config.yaml не найден: запустите SillyTavern один раз и повторите установку');
        process.exit(1);
    }
    let text = fs.readFileSync(config, 'utf8');
    text = /^enableServerPlugins:/m.test(text) ? text.replace(/^enableServerPlugins:.*$/m, 'enableServerPlugins: true') : `${text.trimEnd()}\nenableServerPlugins: true\n`;
    retry('config.yaml', () => fs.writeFileSync(config, text));
    say('В config.yaml включено enableServerPlugins: true');
    const listen = /^listen:\s*true/m.test(text);
    say();
    say('Готово. Перезапустите SillyTavern.');
    say();
    say('Чтобы связать эту таверну с телефоном (Корректор → Ещё → Связь с ПК):');
    if (!listen) say('  • в config.yaml поставьте listen: true — иначе таверна не видна в сети;');
    say('  • и одно из двух: добавьте адрес телефона в whitelist, либо whitelistMode: false и basicAuthMode: true с логином и паролем;');
    say('  • на телефоне впишите адрес этого компьютера: http://IP-компьютера:8000 (в той же Wi‑Fi) или его адрес в Tailscale.');
    say('Пошагово: docs/GUIDE.md');
} catch (error) {
    explain(error);
}
