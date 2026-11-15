const fs = require('node:fs');
const path = require('node:path');
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
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  if (pkg.name.toLowerCase() !== 'sillytavern' || !fs.existsSync(path.join(folder, 'server.js'))) throw new Error('Выберите папку SillyTavern с файлом server.js.');
  const configPath = path.join(folder, 'config.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
  if (config.dataRoot && path.resolve(folder, config.dataRoot) !== path.join(folder, 'data')) throw new Error('Нестандартный dataRoot: установите плагин вручную. Автоматическая установка поддерживает папку data.');
  const port = Number(config.port || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('В config.yaml указан неверный порт.');
  if (config.ssl?.enabled) throw new Error('Для локального HTTPS используйте подключение по адресу и запускайте сервер отдельно.');
  return {url: `http://127.0.0.1:${port}`, configPath};
}
module.exports = {serverURL, pageURL, sameOrigin, localConfig};
