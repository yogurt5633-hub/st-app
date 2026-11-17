const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {compareVersions, installedPluginVersion, depsStamp, hasStDeps, localConfig, extractZipBuffer} = require('./core.cjs');

const RELEASES_URL = 'https://api.github.com/repos/yogurt5633-hub/st-app/releases/latest';
const PLUGIN_PKG_URL = 'https://raw.githubusercontent.com/yogurt5633-hub/st-app/main/plugin/package.json';
const ST_APP_ZIP_URL = 'https://codeload.github.com/yogurt5633-hub/st-app/zip/refs/heads/main';
const SILLYTAVERN_ZIP_URL = 'https://codeload.github.com/SillyTavern/SillyTavern/zip/refs/heads/release';
const NODE_WIN_ZIP_URL = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip';

function runNodeScript(args, cwd, onLine, execBinary = process.execPath) {
  return new Promise((resolve, reject) => {
    const isElectronBin = execBinary === process.execPath;
    const binDir = path.dirname(execBinary);
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
    const env = {
      ...process.env,
      [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] || ''}`,
      NODE_ENV: 'production',
    };
    if (isElectronBin) env.ELECTRON_RUN_AS_NODE = '1';
    const tail = [];
    const proc = spawn(execBinary, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handleChunk = chunk => {
      const lines = String(chunk).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        tail.push(line);
        if (tail.length > 10) tail.shift();
        onLine?.(line);
      }
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.once('error', reject);
    proc.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Код ${code}${tail.length ? `: ${tail.slice(-3).join(' | ')}` : ''}`));
    });
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

async function ensureNpmRuntime(userDataDir, onStatus) {
  const runtimeDir = path.join(userDataDir, 'node-runtime');
  const portableCli = path.join(runtimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const portableNode = path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  if (fs.existsSync(portableCli)) {
    return {nodeBin: fs.existsSync(portableNode) ? portableNode : process.execPath, npmCli: portableCli};
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const sysNode = path.join(pf, 'nodejs', 'node.exe');
    const sysNpm = path.join(pf, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(sysNode) && fs.existsSync(sysNpm)) {
      return {nodeBin: sysNode, npmCli: sysNpm};
    }
  } else {
    for (const c of [
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      '/usr/lib/node_modules/npm/bin/npm-cli.js',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    ]) {
      if (fs.existsSync(c)) return {nodeBin: process.execPath, npmCli: c};
    }
  }
  onStatus?.('[Шаг 3/4] Скачиваю портативный Node.js + npm (около 33 МБ) с nodejs.org…');
  const zipBuf = await fetchBuffer(NODE_WIN_ZIP_URL, 180000);
  onStatus?.(`[Шаг 3/4] Node.js скачан (${(zipBuf.length / 1048576).toFixed(1)} МБ), распаковываю…`);
  const entries = extractZipBuffer(zipBuf, runtimeDir, {stripTopDir: true});
  onStatus?.(`[Шаг 3/4] Распаковано записей Node.js: ${entries}`);
  if (!fs.existsSync(portableCli)) throw new Error('Не удалось подготовить npm-cli.js для установки зависимостей');
  return {nodeBin: fs.existsSync(portableNode) ? portableNode : process.execPath, npmCli: portableCli};
}

async function ensureStDependencies(folder, userDataDir, onStatus) {
  const stampFile = path.join(folder, '.tavernka-deps-stamp');
  const currentStamp = depsStamp(folder);
  if (hasStDeps(folder) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8').trim() === currentStamp) {
    onStatus?.('[Шаг 3/4] Зависимости node_modules уже установлены и актуальны.');
    return;
  }
  const {nodeBin, npmCli} = await ensureNpmRuntime(userDataDir, onStatus);
  onStatus?.(`[Шаг 3/4] Запуск npm install (${nodeBin}) в ${folder}. В первый раз это занимает 1–3 минуты…`);
  await runNodeScript(
    [npmCli, 'install', '--no-save', '--no-audit', '--no-fund', '--loglevel=http', '--omit=dev', '--ignore-scripts'],
    folder,
    onStatus,
    nodeBin,
  );
  if (!hasStDeps(folder)) {
    throw new Error('После npm install в папке node_modules не найден пакет express. Проверьте доступ к интернету и антивирус.');
  }
  fs.writeFileSync(stampFile, currentStamp, 'utf8');
  onStatus?.('[Шаг 3/4] Все зависимости SillyTavern (node_modules) успешно установлены.');
}

async function installOrUpdateSillyTavern({folder, userDataDir, bundleDir, onStatus}) {
  fs.mkdirSync(folder, {recursive: true});
  const isUpdate = fs.existsSync(path.join(folder, 'server.js'));
  onStatus?.(`[Шаг 1/4] ${isUpdate ? 'Скачиваю обновление SillyTavern' : 'Скачиваю SillyTavern (ветка release)'} с GitHub в ${folder}…`);
  const zipBuf = await fetchBuffer(SILLYTAVERN_ZIP_URL, 180000);
  onStatus?.(`[Шаг 2/4] Архив SillyTavern скачан (${(zipBuf.length / 1048576).toFixed(1)} МБ). Распаковываю файлы…`);
  const count = extractZipBuffer(zipBuf, folder, {
    stripTopDir: true,
    preserveTop: ['data', 'config.yaml', 'secrets.json', 'plugins', '.tavernka-backups'],
  });
  onStatus?.(`[Шаг 2/4] Распаковано записей архива: ${count}. Проверяю server.js и config.yaml…`);
  if (!fs.existsSync(path.join(folder, 'server.js'))) {
    throw new Error('После распаковки архива не найден server.js');
  }
  const cfgPath = path.join(folder, 'config.yaml');
  const defCfg = path.join(folder, 'default', 'config.yaml');
  if (!fs.existsSync(cfgPath) && fs.existsSync(defCfg)) {
    fs.copyFileSync(defCfg, cfgPath);
  }
  await ensureStDependencies(folder, userDataDir, onStatus);
  onStatus?.('[Шаг 4/4] Устанавливаю плагин и расширение Корректора…');
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

