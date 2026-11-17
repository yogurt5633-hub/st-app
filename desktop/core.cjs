const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const YAML = require('yaml');

function serverURL(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) throw new Error('Укажите полный адрес: http://192.168.1.10:8000 или https://…');
  const url = new URL(text);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Укажите только адрес сервера и порт, без пароля, пути и параметров.');
  }
  return url.origin;
}
function pageURL(origin, tab) {
  const routes = {tavern: '/', korrektor: '/api/plugins/korrektor/app/', catalog: '/api/plugins/korrektor/app/#tools/catalog'};
  if (!Object.hasOwn(routes, tab)) throw new Error('Неизвестная вкладка');
  return serverURL(origin) + routes[tab];
}
function sameOrigin(value, origin) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) && new URL(value).origin === serverURL(origin); }
  catch { return false; }
}
function localConfig(folder) {
  if (!folder || !fs.existsSync(path.join(folder, 'package.json'))) {
    throw new Error('Выберите папку SillyTavern с файлом server.js или нажмите «Установить SillyTavern».');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  if (String(pkg.name || '').toLowerCase() !== 'sillytavern' || !fs.existsSync(path.join(folder, 'server.js'))) {
    throw new Error('Выберите папку SillyTavern с файлом server.js.');
  }
  const configPath = path.join(folder, 'config.yaml');
  const defaultConfigPath = path.join(folder, 'default', 'config.yaml');
  if (!fs.existsSync(configPath) && fs.existsSync(defaultConfigPath)) {
    fs.copyFileSync(defaultConfigPath, configPath);
  }
  const config = fs.existsSync(configPath) ? (YAML.parse(fs.readFileSync(configPath, 'utf8')) || {}) : {};
  if (config.dataRoot && path.resolve(folder, config.dataRoot) !== path.join(folder, 'data')) {
    throw new Error('Нестандартный dataRoot: установите плагин вручную. Автоматическая установка поддерживает папку data.');
  }
  const port = Number(config.port || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('В config.yaml указан неверный порт.');
  if (config.ssl?.enabled) throw new Error('Для локального HTTPS используйте подключение по адресу и запускайте сервер отдельно.');
  return {url: `http://127.0.0.1:${port}`, port, listen: Boolean(config.listen), configPath};
}
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^[^0-9]*/, '').split(/[.-]/).map(x => Number(x) || 0);
  const pb = String(b || '').replace(/^[^0-9]*/, '').split(/[.-]/).map(x => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function installedPluginVersion(folder) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'plugins', 'korrektor', 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

function depsStamp(folder) {
  try {
    const p1 = fs.existsSync(path.join(folder, 'package.json')) ? fs.statSync(path.join(folder, 'package.json')).size : 0;
    const p2 = fs.existsSync(path.join(folder, 'package-lock.json')) ? fs.statSync(path.join(folder, 'package-lock.json')).size : 0;
    return `${p1}:${p2}`;
  } catch {
    return '';
  }
}

function hasStDeps(folder) {
  try {
    const pkgPath = path.join(folder, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg?.dependencies?.express) {
      return fs.existsSync(path.join(folder, 'node_modules', 'express', 'package.json')) &&
        fs.existsSync(path.join(folder, 'node_modules', 'yaml', 'package.json'));
    }
    return fs.existsSync(path.join(folder, 'node_modules'));
  } catch {
    return false;
  }
}

function localAddresses(port = 8000) {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets || {})) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal && info.address) {
        out.push(`http://${info.address}:${port}`);
      }
    }
  }
  return out;
}

function setLanListen(folder, enabled) {
  const cfg = localConfig(folder);
  let text = fs.existsSync(cfg.configPath) ? fs.readFileSync(cfg.configPath, 'utf8') : '';
  if (/^listen:\s*(true|false)/m.test(text)) {
    text = text.replace(/^listen:\s*(true|false)/m, `listen: ${Boolean(enabled)}`);
  } else {
    text += `\nlisten: ${Boolean(enabled)}\n`;
  }
  fs.writeFileSync(cfg.configPath, text, 'utf8');
  return localConfig(folder);
}

function extractZipBuffer(buffer, targetDir, {stripTopDir = true, preserveTop = []} = {}) {
  let eocd = -1;
  const minEocd = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Скачанный файл не является ZIP-архивом');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const preserve = new Set(preserveTop);
  fs.mkdirSync(targetDir, {recursive: true});

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-архив повреждён');
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    let rel = rawName;
    if (stripTopDir) {
      const slash = rel.indexOf('/');
      if (slash < 0) continue;
      rel = rel.slice(slash + 1);
    }
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
    const top = rel.split('/')[0];
    if (preserve.has(top) && fs.existsSync(path.join(targetDir, top))) continue;

    const dest = path.join(targetDir, ...rel.split('/'));
    if (!dest.startsWith(path.resolve(targetDir) + path.sep) && dest !== path.resolve(targetDir)) continue;
    if (rawName.endsWith('/')) {
      fs.mkdirSync(dest, {recursive: true});
      continue;
    }
    if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Заголовок файла в ZIP повреждён');
    const localNameLen = buffer.readUInt16LE(offset + 26);
    const localExtraLen = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const body = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? body : method === 8 ? zlib.inflateRawSync(body) : null;
    if (!data) continue;
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.writeFileSync(dest, data);
  }
  return count;
}

module.exports = {
  serverURL,
  pageURL,
  sameOrigin,
  localConfig,
  compareVersions,
  installedPluginVersion,
  depsStamp,
  hasStDeps,
  localAddresses,
  setLanListen,
  extractZipBuffer,
};


