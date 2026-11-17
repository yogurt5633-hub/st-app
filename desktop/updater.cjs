const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {compareVersions, installedPluginVersion, depsStamp, localConfig, extractZipBuffer} = require('./core.cjs');

const RELEASES_URL = 'https://api.github.com/repos/yogurt5633-hub/st-app/releases/latest';
const PLUGIN_PKG_URL = 'https://raw.githubusercontent.com/yogurt5633-hub/st-app/main/plugin/package.json';
const ST_APP_ZIP_URL = 'https://codeload.github.com/yogurt5633-hub/st-app/zip/refs/heads/main';
const SILLYTAVERN_ZIP_URL = 'https://codeload.github.com/SillyTavern/SillyTavern/zip/refs/heads/release';
const NODE_WIN_ZIP_URL = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip';

function runNodeScript(args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: {...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handleChunk = chunk => {
      if (!onLine) return;
      const lines = String(chunk).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length) onLine(lines.at(-1));
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.once('error', reject);
    proc.once('exit', code => code === 0 ? resolve() : reject(new Error(`Команда завершилась с кодом ${code}`)));
  });
}

async function fetchBuffer(url, timeoutMs = 120000) {
  const res = await fetch(url, {
    headers: {'User-Agent': 'Tavernka-Desktop'},
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status} при скачивании ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function backupTavernFiles(folder) {
  const backup = path.join(folder, '.tavernka-backups', String(Date.now()));
  fs.mkdirSync(backup, {recursive: true});
  const cfgPath = path.join(folder, 'config.yaml');
  if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, path.join(backup, 'config.yaml'));
  const dataDir = path.join(folder, 'data');
  const users = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
  for (const relative of ['plugins/korrektor', ...users.map(u => `data/${u}/extensions/korrektor-sync`)]) {
    const source = path.join(folder, relative);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backup, relative), {recursive: true});
  }
  return backup;
}

async function installKorrektorInto(folder, bundleDir, {downloadFresh = false, onStatus} = {}) {
  const config = localConfig(folder);
  const backup = backupTavernFiles(folder);
  let sourceRoot = bundleDir;
  let tempDir = null;
  if (downloadFresh) {
    try {
      onStatus?.('Скачиваю свежую версию Корректора с GitHub…');
      const zipBuf = await fetchBuffer(ST_APP_ZIP_URL, 60000);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavernka-src-'));
      extractZipBuffer(zipBuf, tempDir, {stripTopDir: true});
      if (fs.existsSync(path.join(tempDir, 'scripts', 'install.mjs'))) {
        sourceRoot = tempDir;
      }
    } catch {
      onStatus?.('GitHub недоступен: ставлю встроенную копию Корректора…');
    }
  }
  try {
    onStatus?.('Устанавливаю плагин и расширение Корректора…');
    await runNodeScript([path.join(sourceRoot, 'scripts', 'install.mjs'), folder], folder, onStatus);
    return {installedVersion: installedPluginVersion(folder), url: config.url, backup};
  } catch (error) {
    throw new Error(`Установка завершилась с ошибкой (${error.message}). Копия сохранена: ${backup}`);
  } finally {
    if (tempDir) fs.rmSync(tempDir, {recursive: true, force: true});
  }
}

async function ensureNpmCli(userDataDir, onStatus) {
  const candidates = [
    path.join(userDataDir, 'node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const sysNpm = path.join(pf, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(sysNpm)) return sysNpm;
  }
  onStatus?.('Скачиваю пакетный менеджер npm для установки зависимостей SillyTavern…');
  const runtimeDir = path.join(userDataDir, 'node-runtime');
  const zipBuf = await fetchBuffer(NODE_WIN_ZIP_URL, 180000);
  extractZipBuffer(zipBuf, runtimeDir, {stripTopDir: true});
  const cli = path.join(runtimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error('Не удалось подготовить npm для установки зависимостей');
  return cli;
}

async function ensureStDependencies(folder, userDataDir, onStatus) {
  const stampFile = path.join(folder, '.tavernka-deps-stamp');
  const currentStamp = depsStamp(folder);
  const hasModules = fs.existsSync(path.join(folder, 'node_modules', 'express')) ||
    (fs.existsSync(path.join(folder, 'node_modules')) && fs.readdirSync(path.join(folder, 'node_modules')).length > 0);
  if (hasModules && (!fs.existsSync(stampFile) || fs.readFileSync(stampFile, 'utf8').trim() === currentStamp)) {
    return;
  }
  const npmCli = await ensureNpmCli(userDataDir, onStatus);
  onStatus?.('Устанавливаю зависимости SillyTavern (npm install). В первый раз это занимает 1–3 минуты…');
  await runNodeScript(
    [npmCli, 'install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--no-progress', '--omit=dev', '--ignore-scripts'],
    folder,
    onStatus,
  );
  fs.writeFileSync(stampFile, currentStamp, 'utf8');
}

async function installOrUpdateSillyTavern({folder, userDataDir, bundleDir, onStatus}) {
  fs.mkdirSync(folder, {recursive: true});
  const isUpdate = fs.existsSync(path.join(folder, 'server.js'));
  onStatus?.(isUpdate ? 'Скачиваю обновление SillyTavern с GitHub…' : 'Скачиваю SillyTavern (ветка release) с GitHub…');
  const zipBuf = await fetchBuffer(SILLYTAVERN_ZIP_URL, 180000);
  onStatus?.('Распаковываю файлы SillyTavern (ваши чаты, настройки и плагины сохраняются)…');
  extractZipBuffer(zipBuf, folder, {
    stripTopDir: true,
    preserveTop: ['data', 'config.yaml', 'secrets.json', 'plugins', '.tavernka-backups'],
  });
  const cfgPath = path.join(folder, 'config.yaml');
  const defCfg = path.join(folder, 'default', 'config.yaml');
  if (!fs.existsSync(cfgPath) && fs.existsSync(defCfg)) {
    fs.copyFileSync(defCfg, cfgPath);
  }
  await ensureStDependencies(folder, userDataDir, onStatus);
  await installKorrektorInto(folder, bundleDir, {downloadFresh: true, onStatus});
  return localConfig(folder);
}

async function checkUpdates({currentAppVersion, folder, bundledPluginVersion}) {
  const out = {
    lastCheck: Date.now(),
    app: {current: currentAppVersion, latest: '', available: false, url: '', notes: '', error: ''},
    korrektor: {current: folder ? installedPluginVersion(folder) : '', latest: bundledPluginVersion || '', available: false, error: ''},
  };
  try {
    const res = await fetch(RELEASES_URL, {
      headers: {'User-Agent': 'Tavernka-Desktop', Accept: 'application/vnd.github+json'},
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = await res.json();
      const assets = Array.isArray(json.assets) ? json.assets : [];
      const exe = assets.find(a => String(a?.name || '').endsWith('Setup.exe'));
      const exeName = String(exe?.name || '');
      const verMatch = exeName.match(/Tavernka-([0-9.]+)-Windows/i) || String(json.name || '').match(/([0-9]+\.[0-9]+\.[0-9]+)/);
      const latest = verMatch ? verMatch[1] : String(json.tag_name || '').replace(/^app-/, '');
      out.app.latest = latest;
      out.app.url = String(exe?.browser_download_url || '');
      out.app.notes = String(json.body || '');
      out.app.available = Boolean(out.app.url && compareVersions(latest, currentAppVersion) > 0);
    } else {
      out.app.error = `GitHub ответил ${res.status}`;
    }
  } catch {
    out.app.error = 'Не удалось проверить релизы на GitHub';
  }

  try {
    const res = await fetch(PLUGIN_PKG_URL, {
      headers: {'User-Agent': 'Tavernka-Desktop'},
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const pkg = await res.json();
      if (pkg?.version) out.korrektor.latest = String(pkg.version);
    }
  } catch {
    out.korrektor.error = 'Показана версия встроенного плагина';
  }
  if (out.korrektor.latest && out.korrektor.current) {
    out.korrektor.available = compareVersions(out.korrektor.latest, out.korrektor.current) > 0;
  }
  return out;
}

async function downloadAppInstaller(url, onStatus) {
  if (!url || !/^https:\/\/github\.com\//i.test(url)) throw new Error('Ссылка на установщик обновления не найдена');
  onStatus?.('Скачиваю установщик новой версии Тавернки…');
  const buf = await fetchBuffer(url, 180000);
  const file = path.join(os.tmpdir(), `Tavernka-Update-${Date.now()}-Setup.exe`);
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = {
  installKorrektorInto,
  ensureStDependencies,
  installOrUpdateSillyTavern,
  checkUpdates,
  downloadAppInstaller,
};

