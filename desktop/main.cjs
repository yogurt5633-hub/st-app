const {app, BrowserWindow, WebContentsView, ipcMain, dialog, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {
  serverURL, pageURL, sameOrigin, localConfig, compareVersions,
  installedPluginVersion, hasStDeps, localAddresses, setLanListen,
} = require('./core.cjs');
const {
  installKorrektorInto, ensureStDependencies, installOrUpdateSillyTavern,
  checkUpdates, downloadAppInstaller,
} = require('./updater.cjs');

const DEFAULT_SITES = [
  {name: 'OpenRouter', url: 'https://openrouter.ai/settings/keys'},
  {name: 'Элизиум', url: 'https://elysiumai.garden/'},
  {name: 'DDTokens', url: 'https://www.apiddt.com/'},
];

let win, child, installer, quitting = false, busy = false, selected = 'home';
let prefs = {
  url: 'http://127.0.0.1:8000',
  folder: '',
  theme: 'dark',
  accent: 'amber',
  whatsNewSeen: '',
  seenCatalogIds: [],
  autoStart: false,
  autoUpdate: true,
  showSites: true,
  companionVisible: true,
  siteIndex: 0,
  sites: DEFAULT_SITES,
};
let catalogNewCount = 0;
let latestCatalogIds = [];
let updatesInfo = null;
let logLines = [];
let message = 'Выберите установленную Таверну, установите её в один клик или подключитесь по адресу.';
const views = new Map();
const homeFile = path.join(__dirname, 'ui', 'index.html');
const settingsFile = () => path.join(app.getPath('userData'), 'connection.json');
const bundleRoot = () => app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.resolve(__dirname, '..');

function addLog(line) {
  const clean = String(line || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[СКРЫТО]')
    .trim();
  if (!clean) return;
  const stamp = new Date().toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const entry = `${stamp} ${clean}`;
  logLines.push(entry);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'tavernka-install.log'), entry + '\n', 'utf8');
  } catch {}
}

function localStDetails() {
  if (!prefs.folder) return {installed: false, depsInstalled: false, pluginVersion: '', listen: false, lanUrls: []};
  try {
    const cfg = localConfig(prefs.folder);
    const depsOk = hasStDeps(prefs.folder);
    return {
      installed: true,
      depsInstalled: depsOk,
      pluginVersion: installedPluginVersion(prefs.folder),
      listen: cfg.listen,
      lanUrls: localAddresses(cfg.port),
    };
  } catch {
    return {installed: false, depsInstalled: false, pluginVersion: '', listen: false, lanUrls: []};
  }
}

const snapshot = () => ({
  ...prefs,
  ...localStDetails(),
  version: app.getVersion(),
  running: Boolean(child),
  busy,
  selected,
  message,
  logs: logLines.join('\n'),
  updates: updatesInfo,
  catalogNewCount,
  whatsNewPending: Boolean(prefs.whatsNewSeen && prefs.whatsNewSeen !== app.getVersion()),
});
function announce(text) { if (text) message = text; if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); }
function save() { fs.writeFileSync(settingsFile(), JSON.stringify(prefs)); }
function passThemeToViews() {
  const t = JSON.stringify(prefs.theme === 'system' ? '' : (prefs.theme || 'dark'));
  const a = JSON.stringify(prefs.accent || 'amber');
  for (const view of views.values()) {
    view.webContents.executeJavaScript(`window.korrektorTheme&&window.korrektorTheme(${t},${a})`).catch(() => {});
  }
}
async function checkCatalogLive() {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/yogurt5633-hub/st-app/main/catalog/catalog.json?t=${Math.floor(Date.now() / 30000)}`, {signal: AbortSignal.timeout(10000)});
    if (!res.ok) return;
    const data = await res.json();
    const ids = Array.isArray(data?.items) ? data.items.map(i => String(i?.id || '')).filter(Boolean) : [];
    if (!ids.length) return;
    latestCatalogIds = ids;
    if (!Array.isArray(prefs.seenCatalogIds) || !prefs.seenCatalogIds.length) {
      prefs.seenCatalogIds = ids;
      save();
      return;
    }
    const seen = new Set(prefs.seenCatalogIds);
    const fresh = ids.filter(id => !seen.has(id)).length;
    if (selected === 'catalog') {
      prefs.seenCatalogIds = [...new Set([...prefs.seenCatalogIds, ...ids])];
      catalogNewCount = 0;
      save();
    } else if (fresh !== catalogNewCount) {
      catalogNewCount = fresh;
      announce();
    }
  } catch {}
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  for (const [name, view] of views) {
    view.setVisible(name === selected);
    view.setBounds({x: 0, y: 104, width, height: Math.max(0, height - 104)});
  }
}
function clearViews() {
  for (const view of views.values()) { win.contentView.removeChildView(view); view.webContents.close(); }
  views.clear(); selected = 'home'; layout();
}
async function select(name) {
  if (name === 'home') { selected = name; layout(); announce(); return; }
  if (name === 'sites') {
    selected = 'sites';
    const list = Array.isArray(prefs.sites) && prefs.sites.length ? prefs.sites : DEFAULT_SITES;
    const idx = Math.min(Math.max(Number(prefs.siteIndex) || 0, 0), list.length - 1);
    const siteUrl = list[idx]?.url || 'https://openrouter.ai/settings/keys';
    if (!views.has('sites')) {
      const view = new WebContentsView({webPreferences: {partition: 'persist:tavernka-sites', nodeIntegration: false, contextIsolation: true, sandbox: true}});
      views.set('sites', view);
      win.contentView.addChildView(view);
      const wc = view.webContents;
      wc.setWindowOpenHandler(({url}) => {
        if (/^https?:\/\//i.test(url)) wc.loadURL(url).catch(() => {});
        return {action: 'deny'};
      });
      wc.on('will-attach-webview', event => event.preventDefault());
      wc.loadURL(siteUrl).catch(() => {});
    }
    layout(); announce();
    return;
  }
  const target = pageURL(prefs.url, name);
  selected = name;
  if (name === 'catalog' && latestCatalogIds.length) {
    prefs.seenCatalogIds = [...new Set([...(prefs.seenCatalogIds || []), ...latestCatalogIds])];
    catalogNewCount = 0;
    save();
  }
  if (!views.has(name)) {
    const origin = prefs.url;
    const view = new WebContentsView({webPreferences: {partition: 'persist:tavernka', nodeIntegration: false, contextIsolation: true, sandbox: true}});
    views.set(name, view); win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.setUserAgent(`${wc.getUserAgent()} KorrektorApp/${app.getVersion()}`);
    wc.setWindowOpenHandler(({url}) => {
      if (sameOrigin(url, origin)) wc.loadURL(url).catch(() => {});
      return {action: 'deny'};
    });
    for (const event of ['will-navigate', 'will-redirect']) wc.on(event, (e, url) => { if (!sameOrigin(url, origin)) e.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('did-finish-load', () => passThemeToViews());
    wc.on('did-fail-load', (_e, code, _desc, _url, mainFrame) => {
      if (code === -3 || !mainFrame) return;
      selected = 'home'; layout(); announce('Сервер недоступен. Проверьте адрес, запуск Таверны и доступ по сети. Затем откройте вкладку повторно.');
      views.delete(name); win.contentView.removeChildView(view); wc.close();
    });
    wc.on('render-process-gone', () => { views.delete(name); win.contentView.removeChildView(view); selected = 'home'; layout(); announce('Вкладка закрылась. Откройте её повторно.'); });
    wc.loadURL(target).catch(() => {});
  }
  layout(); announce();
}
function runNode(args, cwd) {
  return spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    shell: false,
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false', SILLYTAVERN_AUTORUN: 'false'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stop() {
  const owned = child;
  if (!owned) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { owned.kill('SIGKILL'); }, 5000);
    owned.once('exit', () => { clearTimeout(timer); resolve(); });
    owned.kill();
  });
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(homeFile).href) throw new Error('Untrusted sender');
    try { const value = await fn(...args); return {ok: true, value, state: snapshot()}; }
    catch (error) {
      addLog(`❌ ОШИБКА (${channel}): ${error.message}`);
      announce(`Ошибка: ${error.message}`);
      return {ok: false, error: error.message, state: snapshot()};
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('login', (event, contents, details, authInfo, callback) => {
    event.preventDefault();
    if (authInfo.isProxy || !sameOrigin(details.url, prefs.url) || ![...views.values()].some(view => view.webContents === contents)) { callback(); return; }
    const auth = new BrowserWindow({parent: win, modal: true, width: 480, height: 440, resizable: false, autoHideMenuBar: true, webPreferences: {preload: path.join(__dirname, 'auth-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true}});
    let completed = false;
    const finish = value => {
      if (completed) return;
      completed = true; ipcMain.removeListener('auth-response', receive);
      if (value && typeof value.username === 'string' && typeof value.password === 'string') callback(value.username, value.password);
      else callback();
      if (!auth.isDestroyed()) auth.close();
    };
    const receive = (e, value) => {
      if (e.sender === auth.webContents && e.senderFrame === auth.webContents.mainFrame) finish(value);
    };
    ipcMain.on('auth-response', receive);
    auth.on('closed', () => finish(null));
    auth.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    auth.webContents.on('will-navigate', e => e.preventDefault());
    auth.webContents.on('did-finish-load', () => auth.webContents.send('auth-host', authInfo.host));
    auth.loadFile(path.join(__dirname, 'ui/auth.html'));
  });
  app.whenReady().then(() => {
    try {
      const stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
      prefs = {
        ...prefs,
        url: serverURL(stored.url),
        folder: String(stored.folder || ''),
        theme: ['dark', 'light', 'midnight', 'mist', 'brown', 'system'].includes(stored.theme) ? stored.theme : 'dark',
        accent: ['amber', 'rose', 'mint', 'sky', 'lavender'].includes(stored.accent) ? stored.accent : 'amber',
        whatsNewSeen: String(stored.whatsNewSeen || app.getVersion()),
        seenCatalogIds: Array.isArray(stored.seenCatalogIds) ? stored.seenCatalogIds.map(String) : [],
        autoStart: Boolean(stored.autoStart),
        autoUpdate: stored.autoUpdate !== false,
        showSites: stored.showSites !== false,
        companionVisible: stored.companionVisible !== false,
        siteIndex: Number(stored.siteIndex) || 0,
        sites: Array.isArray(stored.sites) && stored.sites.length ? stored.sites : DEFAULT_SITES,
      };
    } catch {
      prefs.whatsNewSeen = app.getVersion();
    }
    session.fromPartition('persist:tavernka').setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.fromPartition('persist:tavernka').setPermissionCheckHandler(() => false);
    win = new BrowserWindow({width: 1160, height: 820, minWidth: 720, minHeight: 580, title: 'Тавернка', autoHideMenuBar: true, backgroundColor: '#191816', webPreferences: {preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true}});
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.on('resize', layout);
    win.on('close', event => { if (busy) { event.preventDefault(); announce('Дождитесь окончания установки Корректора, затем закройте приложение.'); } });
    handle('state', () => snapshot());
    handle('choose-folder', async () => {
      if (child || busy) throw new Error('Сначала остановите Таверну.');
      const result = await dialog.showOpenDialog(win, {properties: ['openDirectory', 'createDirectory'], title: 'Папка для SillyTavern'});
      if (result.canceled) return;
      const folder = result.filePaths[0];
      try {
        const config = localConfig(folder);
        prefs = {...prefs, folder, url: config.url};
        save();
        clearViews();
        announce('Папка выбрана. Установите Корректор, затем запустите Таверну.');
      } catch {
        prefs = {...prefs, folder};
        save();
        clearViews();
        announce('Папка выбрана. Нажмите «Установить SillyTavern», чтобы автоматически скачать и настроить таверну в эту папку.');
      }
    });
    handle('connect', async url => {
      if (child || busy) throw new Error('Сначала остановите локальную Таверну.');
      prefs.url = serverURL(url); save(); clearViews(); await select('tavern');
    });
    handle('tab', select);
    handle('open-korrektor', async hash => {
      const clean = String(hash || '#feed');
      const isCat = clean.startsWith('#tools/catalog');
      await select(isCat ? 'catalog' : 'korrektor');
      const view = views.get(isCat ? 'catalog' : 'korrektor');
      if (view) view.webContents.executeJavaScript(`location.hash=${JSON.stringify(clean)}`).catch(() => {});
    });
    handle('open-site', async index => {
      const list = Array.isArray(prefs.sites) && prefs.sites.length ? prefs.sites : DEFAULT_SITES;
      const idx = Math.min(Math.max(Number(index) || 0, 0), list.length - 1);
      prefs.siteIndex = idx;
      save();
      await select('sites');
      const view = views.get('sites');
      if (view && list[idx]?.url) view.webContents.loadURL(list[idx].url).catch(() => {});
    });
    handle('set-sites', list => {
      if (!Array.isArray(list)) throw new Error('Неверный список сайтов');
      const clean = [];
      for (const item of list.slice(0, 20)) {
        const name = String(item?.name || '').trim().slice(0, 40);
        let url = String(item?.url || '').trim();
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        const parsed = new URL(url);
        if (!name || !parsed.hostname.includes('.')) throw new Error(`Проверьте адрес сайта: ${name || url}`);
        clean.push({name, url: parsed.href});
      }
      prefs.sites = clean.length ? clean : DEFAULT_SITES;
      prefs.siteIndex = 0;
      save();
      announce('Список сайтов сохранён.');
    });
    handle('set-flag', (key, value) => {
      if (['autoStart', 'autoUpdate', 'showSites', 'companionVisible'].includes(key)) {
        prefs[key] = Boolean(value);
        save();
      } else if (key === 'lanListen' && prefs.folder) {
        setLanListen(prefs.folder, Boolean(value));
        announce(value ? 'Доступ с телефона в локальной сети включён (перезапустите Таверну, если она уже работает).' : 'Доступ по локальной сети выключен.');
      }
    });
    handle('dashboard', async () => {
      try {
        const [stRes, chRes, usRes] = await Promise.all([
          fetch(`${prefs.url}/api/plugins/korrektor/status`, {signal: AbortSignal.timeout(3000)}),
          fetch(`${prefs.url}/api/plugins/korrektor/chats?limit=1`, {signal: AbortSignal.timeout(3000)}),
          fetch(`${prefs.url}/api/plugins/korrektor/usage?days=1`, {signal: AbortSignal.timeout(3000)}),
        ]);
        const status = stRes.ok ? await stRes.json() : null;
        const chats = chRes.ok ? await chRes.json() : null;
        const usage = usRes.ok ? await usRes.json() : null;
        return {
          ok: Boolean(status),
          status,
          lastChat: chats?.items?.[0] || null,
          today: usage?.byDay?.at(-1) || null,
        };
      } catch {
        return {ok: false};
      }
    });
    handle('reload', () => views.get(selected)?.webContents.reload());
    handle('theme', (theme, accent) => {
      if (['dark', 'light', 'midnight', 'mist', 'brown', 'system'].includes(theme)) prefs.theme = theme;
      if (['amber', 'rose', 'mint', 'sky', 'lavender'].includes(accent)) prefs.accent = accent;
      save();
      passThemeToViews();
    });
    handle('dismiss-whats-new', () => {
      prefs.whatsNewSeen = app.getVersion();
      save();
    });
    handle('check-updates', async () => {
      const bundledPkg = path.join(bundleRoot(), 'plugin', 'package.json');
      const bundledVer = fs.existsSync(bundledPkg) ? JSON.parse(fs.readFileSync(bundledPkg, 'utf8')).version : app.getVersion();
      updatesInfo = await checkUpdates({currentAppVersion: app.getVersion(), folder: prefs.folder, bundledPluginVersion: bundledVer});
      announce();
    });
    handle('install-app-update', async () => {
      const url = updatesInfo?.app?.url;
      if (!url) throw new Error('Сначала нажмите «Проверить обновления».');
      busy = true;
      try {
        const exe = await downloadAppInstaller(url, text => { addLog(text); announce(text); });
        await stop();
        spawn(exe, [], {detached: true, stdio: 'ignore'}).unref();
        quitting = true;
        setTimeout(() => app.quit(), 300);
      } finally {
        busy = false;
      }
    });
    handle('install-tavern', async () => {
      if (child || busy) throw new Error('Сначала остановите Таверну.');
      if (!prefs.folder) {
        prefs.folder = path.join(app.getPath('home'), 'SillyTavern');
        save();
      }
      busy = true;
      addLog(`=== Начало установки SillyTavern в ${prefs.folder} ===`);
      announce(`Устанавливаю SillyTavern в ${prefs.folder}… (см. журнал ниже)`);
      try {
        const cfg = await installOrUpdateSillyTavern({
          folder: prefs.folder,
          userDataDir: app.getPath('userData'),
          bundleDir: bundleRoot(),
          onStatus: text => { addLog(text); announce(text); },
        });
        prefs.url = cfg.url;
        save();
        addLog('=== SillyTavern, зависимости node_modules и Корректор успешно установлены! ===');
        announce('SillyTavern и Корректор установлены! Нажмите «Запустить».');
      } finally {
        busy = false;
        announce();
      }
    });
    handle('update-tavern', async () => {
      if (!prefs.folder) throw new Error('Сначала выберите или установите SillyTavern.');
      const wasRunning = Boolean(child);
      if (wasRunning) await stop();
      busy = true;
      try {
        const cfg = await installOrUpdateSillyTavern({
          folder: prefs.folder,
          userDataDir: app.getPath('userData'),
          bundleDir: bundleRoot(),
          onStatus: text => { addLog(text); announce(text); },
        });
        prefs.url = cfg.url;
        save();
        announce('SillyTavern и Корректор обновлены до последней версии.');
      } finally {
        busy = false;
        announce();
      }
    });
    handle('update-korrektor', async () => {
      if (!prefs.folder) throw new Error('Сначала выберите папку SillyTavern.');
      const wasRunning = Boolean(child);
      if (wasRunning) await stop();
      busy = true;
      try {
        const r = await installKorrektorInto(prefs.folder, bundleRoot(), {
          downloadFresh: true,
          onStatus: text => { addLog(text); announce(text); },
        });
        if (updatesInfo?.korrektor) {
          updatesInfo.korrektor.current = r.installedVersion;
          updatesInfo.korrektor.available = false;
        }
        announce(`Корректор обновлён до версии ${r.installedVersion || app.getVersion()}.`);
      } finally {
        busy = false;
        announce();
      }
    });
    handle('install', async () => {
      if (child || busy) throw new Error('Сначала остановите Таверну.');
      const config = localConfig(prefs.folder);
      const answer = await dialog.showMessageBox(win, {type: 'question', buttons: ['Отмена', 'Установить'], defaultId: 1, cancelId: 0, message: 'Установить Корректор в выбранную Таверну?', detail: 'Закройте её, если она запущена отдельно. Плагин и расширение будут обновлены. Перед этим сохраним их копии и config.yaml.'});
      if (answer.response !== 1) return;
      busy = true; announce('Сохраняю копию и устанавливаю Корректор…');
      try {
        const backup = path.join(prefs.folder, '.tavernka-backups', String(Date.now()));
        fs.mkdirSync(backup, {recursive: true});
        fs.copyFileSync(config.configPath, path.join(backup, 'config.yaml'));
        for (const relative of ['plugins/korrektor', ...(fs.existsSync(path.join(prefs.folder, 'data')) ? fs.readdirSync(path.join(prefs.folder, 'data')) : []).map(user => `data/${user}/extensions/korrektor-sync`)]) {
          const source = path.join(prefs.folder, relative);
          if (fs.existsSync(source)) fs.cpSync(source, path.join(backup, relative), {recursive: true});
        }
        const bundle = app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.resolve(__dirname, '..');
        await new Promise((resolve, reject) => {
          installer = runNode([path.join(bundle, 'scripts/install.mjs'), prefs.folder], prefs.folder);
          const onChunk = chunk => {
            for (const l of String(chunk).split(/\r?\n/).map(s => s.trim()).filter(Boolean)) addLog(l);
            announce();
          };
          installer.stdout.on('data', onChunk);
          installer.stderr.on('data', onChunk);
          installer.once('error', reject);
          installer.once('exit', code => code === 0 ? resolve() : reject(new Error(`Установка завершилась с кодом ${code}. Копия сохранена: ${backup}`)));
        });
        announce('Корректор установлен. Теперь запустите Таверну.');
      } finally { installer = null; busy = false; announce(); }
    });
    async function startLocalTavern() {
      if (child || busy) throw new Error('Таверна уже запускается или работает.');
      const config = localConfig(prefs.folder);
      if (!hasStDeps(prefs.folder)) {
        busy = true;
        addLog('Пакеты node_modules ещё не установлены — запускаю автоматическую установку зависимостей…');
        announce('Докачиваю зависимости SillyTavern (npm install)…');
        try {
          await ensureStDependencies(prefs.folder, app.getPath('userData'), text => { addLog(text); announce(text); });
        } finally {
          busy = false;
          announce();
        }
      }
      if (prefs.autoUpdate && updatesInfo?.korrektor?.available) {
        busy = true;
        try {
          await installKorrektorInto(prefs.folder, bundleRoot(), {
            downloadFresh: true,
            onStatus: text => { addLog(text); announce(text); },
          });
          updatesInfo.korrektor.current = installedPluginVersion(prefs.folder);
          updatesInfo.korrektor.available = false;
        } catch {} finally {
          busy = false;
        }
      }
      prefs.url = config.url; save(); clearViews();
      addLog(`=== Запуск SillyTavern (${config.url}) в ${prefs.folder} ===`);
      child = runNode([path.join(prefs.folder, 'server.js'), '--browserLaunchEnabled=false', '--autorun=false'], prefs.folder);
      const owned = child;
      let hadErrorLine = '';
      const onServerOutput = chunk => {
        const lines = String(chunk).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.startsWith('Content file ')) continue;
          addLog(`[ST] ${line.slice(0, 240)}`);
          if (/Compiling frontend libraries/i.test(line)) {
            announce('SillyTavern собирает интерфейс (первый запуск занимает 15–30 сек)…');
          } else if (/SillyTavern is listening on|Launching\.\.\./i.test(line)) {
            announce('Таверна запущена и готова! Откройте вкладку «Таверна».');
          } else if (/critical error|Cannot find package|ERR_MODULE_NOT_FOUND|EADDRINUSE/i.test(line)) {
            hadErrorLine = line;
          }
        }
        announce();
      };
      owned.stdout.on('data', onServerOutput);
      owned.stderr.on('data', onServerOutput);
      owned.once('error', error => {
        child = null;
        addLog(`❌ Ошибка запуска процесса: ${error.message}`);
        announce(`Не удалось запустить: ${error.message}`);
      });
      owned.once('exit', code => {
        if (child === owned) child = null;
        addLog(`SillyTavern остановлен (код ${code ?? 0})${hadErrorLine ? ` — ${hadErrorLine}` : ''}`);
        announce(hadErrorLine ? `Таверна не запустилась: ${hadErrorLine} (подробности в «Журнале»)` : `Таверна остановлена${code ? ` (код ${code})` : ''}.`);
      });
      announce('Таверна запускается. Через несколько секунд откройте вкладку «Таверна» (ход запуска виден в «Журнале»).');
    }
    handle('start', startLocalTavern);
    handle('restart', async () => {
      await stop();
      await startLocalTavern();
    });
    handle('stop', async () => { await stop(); announce('Таверна остановлена.'); });
    win.loadFile(homeFile);
    checkCatalogLive();
    setInterval(checkCatalogLive, 30000).unref?.();
    const bundledPkg = path.join(bundleRoot(), 'plugin', 'package.json');
    const bundledVer = fs.existsSync(bundledPkg) ? JSON.parse(fs.readFileSync(bundledPkg, 'utf8')).version : app.getVersion();
    checkUpdates({currentAppVersion: app.getVersion(), folder: prefs.folder, bundledPluginVersion: bundledVer})
      .then(u => { updatesInfo = u; announce(); }).catch(() => {});
    if (prefs.autoStart && prefs.folder && fs.existsSync(path.join(prefs.folder, 'server.js'))) {
      startLocalTavern().catch(() => {});
    }
  });
  app.on('before-quit', event => {
    if (busy) { event.preventDefault(); announce('Дождитесь окончания установки Корректора.'); return; }
    if ((!child && !installer) || quitting) return;
    event.preventDefault(); quitting = true;
    installer?.kill(); stop().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
