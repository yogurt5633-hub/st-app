const api = window.tavernka;
const $ = id => document.getElementById(id);
let currentState = {theme: 'dark', accent: 'amber'};
let whatsNewManual = false;
let logsOpen = false;
let tipIdx = 0;
let petIdx = 0;

const TIPS = [
  {text: 'Имена меняются при переводе? Добавь их в глоссарий: «Ihan = Ихан». Пустая правая часть сохранит исходное написание.', label: 'Настройки глоссария', hash: '#settings'},
  {text: 'Перед большими изменениями сохрани резервную копию чатов, карточек и настроек.', label: 'Резервные копии', hash: '#tools/backup'},
  {text: 'Карточки, лорбуки, пресеты и расширения собраны в каталоге. В разделе «Таверна → Антивирус» можно проверить дополнения.', label: 'Открыть каталог', hash: '#tools/catalog'},
  {text: 'Управлять промптами пресетов, лорбуками и карточками без лагов можно в разделе «Настройки → Таверна».', label: 'Открыть раздел «Таверна»', hash: '#tavern'},
];
const PETS = [
  'Мур. Устроилась рядом — можно продолжать историю.',
  'Спасибо за ласку. Пусть следующая сцена будет уютной.',
  'Перо на месте, настроение отличное.',
];

function applyTheme(theme, accent) {
  const el = document.documentElement;
  if (theme && theme !== 'system') el.dataset.theme = theme;
  else delete el.dataset.theme;
  if (accent && accent !== 'amber') el.dataset.accent = accent;
  else delete el.dataset.accent;
}

function showTip() {
  const tip = TIPS[tipIdx % TIPS.length];
  $('companion-msg').textContent = tip.text;
  $('companion-act').textContent = tip.label;
  $('companion-act').onclick = () => act(() => api.openKorrektor(tip.hash));
}

async function refreshDashboard() {
  const box = $('dashboard-tiles');
  if (!box) return;
  try {
    const d = await api.dashboard();
    if (!d || !d.ok) { box.hidden = true; return; }
    box.replaceChildren();
    const makeTile = (k, v, s, onclick) => {
      const btn = document.createElement('button');
      btn.className = 'tile';
      btn.type = 'button';
      btn.onclick = onclick;
      for (const [cls, txt] of [['k', k], ['v', String(v)], ['s', s]]) {
        const sp = document.createElement('span');
        sp.className = cls;
        sp.textContent = txt;
        btn.append(sp);
      }
      return btn;
    };
    if (d.lastChat) {
      box.append(makeTile('Продолжить', d.lastChat.title || 'Чат', d.lastChat.file || '', () => act(() => api.tab('tavern'))));
    }
    const openCount = d.status?.open || 0;
    box.append(makeTile('Замечания', d.status?.optimizationPaused ? 'пауза' : openCount, d.status?.optimizationPaused ? 'проверки отключены' : 'в ленте', () => act(() => api.openKorrektor('#feed'))));
    const todayTok = d.today ? (d.today.roleplay || 0) + (d.today.korrektor || 0) : 0;
    box.append(makeTile('Сегодня', todayTok.toLocaleString('ru-RU'), d.today?.cost ? `≈$${d.today.cost.toFixed(2)}` : 'токенов', () => act(() => api.openKorrektor('#tools/spend'))));
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}


function render(state) {
  currentState = state;
  applyTheme(state.theme, state.accent);
  $('status').textContent = state.message;
  $('folder').textContent = state.folder || 'Папка ещё не выбрана';
  if (state.version) $('version-label').textContent = `для Windows · ${state.version}`;
  if (document.activeElement !== $('url')) $('url').value = state.url;

  const catalogBtn = $('catalog-tab');
  if (catalogBtn) catalogBtn.textContent = state.catalogNewCount > 0 ? `Каталог · +${state.catalogNewCount}` : 'Каталог';

  const sitesTab = $('sites-tab');
  if (sitesTab) sitesTab.hidden = state.showSites === false;

  const compBox = $('companion-box');
  if (compBox) compBox.hidden = state.companionVisible === false;

  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-current', button.dataset.tab === state.selected ? 'page' : 'false');
  }
  for (const button of document.querySelectorAll('[data-theme]')) {
    button.setAttribute('aria-current', button.dataset.theme === (state.theme || 'dark') ? 'page' : 'false');
  }
  for (const button of document.querySelectorAll('[data-accent]')) {
    button.setAttribute('aria-current', button.dataset.accent === (state.accent || 'amber') ? 'page' : 'false');
  }

  $('install-tavern').disabled = state.busy || state.running;
  for (const id of ['choose', 'install', 'start']) $(id).disabled = state.busy || state.running || (id !== 'choose' && !state.folder);
  $('restart').disabled = state.busy || !state.running;
  $('stop').disabled = !state.running;
  $('connection').querySelector('button').disabled = state.busy || state.running;

  const logsBox = $('logs-box');
  if (logsBox) {
    logsBox.hidden = !logsOpen;
    logsBox.textContent = state.logs || 'Журнал пока пуст.';
  }

  const u = state.updates;
  if (u?.app) {
    $('app-update-meta').textContent = `Установлена ${state.version || '?'}${u.app.latest ? ` · на GitHub ${u.app.latest}` : ''}${u.app.error ? ` (${u.app.error})` : ''}`;
    $('update-app-btn').hidden = !u.app.available;
    $('update-app-btn').disabled = state.busy;
  }
  if (u?.korrektor) {
    const inst = state.pluginVersion || u.korrektor.current || 'не установлен';
    $('plugin-update-meta').textContent = `В таверне: ${inst}${u.korrektor.latest ? ` · последняя: ${u.korrektor.latest}` : ''}`;
    $('update-korrektor-btn').textContent = u.korrektor.available ? `Обновить до ${u.korrektor.latest}` : 'Обновить Корректор';
  }
  $('update-korrektor-btn').disabled = state.busy || !state.folder;
  $('update-tavern-btn').disabled = state.busy || !state.folder;
  $('check-updates-btn').disabled = state.busy;

  $('auto-start-toggle').checked = Boolean(state.autoStart);
  $('auto-update-toggle').checked = state.autoUpdate !== false;
  $('show-sites-toggle').checked = state.showSites !== false;
  $('companion-toggle').checked = state.companionVisible !== false;
  $('lan-listen-toggle').checked = Boolean(state.listen);
  $('lan-listen-toggle').disabled = !state.installed;
  $('lan-urls').textContent = state.lanUrls?.length
    ? `Адреса этого ПК для телефона: ${state.lanUrls.join(' , ')}`
    : 'Когда Таверна установлена и доступ включён, здесь появится адрес этого ПК для телефона.';

  const sitesList = $('sites-list');
  if (sitesList) {
    sitesList.replaceChildren();
    (state.sites || []).forEach((s, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = s.name;
      btn.onclick = () => act(() => api.openSite(idx));
      sitesList.append(btn);
    });
  }

  const modal = $('whats-new-modal');
  if (modal) modal.hidden = !(whatsNewManual || state.whatsNewPending);
  if (state.running) refreshDashboard();
}

async function act(fn) {
  try { const result = await fn(); if (result && result.state) render(result.state); else render(await api.state()); }
  catch (e) { $('status').textContent = e?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || 'Действие не выполнено. Попробуйте ещё раз.'; }
}

api.onState(render);
for (const [id, method] of [
  ['choose', 'chooseFolder'],
  ['install', 'install'],
  ['install-tavern', 'installTavern'],
  ['update-tavern-btn', 'updateTavern'],
  ['update-korrektor-btn', 'updateKorrektor'],
  ['check-updates-btn', 'checkUpdates'],
  ['update-app-btn', 'installAppUpdate'],
  ['start', 'start'],
  ['restart', 'restart'],
  ['stop', 'stop'],
  ['reload', 'reload'],
]) $(id).onclick = () => act(() => api[method]());

$('logs-btn').onclick = () => { logsOpen = !logsOpen; render(currentState); };
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => act(() => api.tab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-theme]')) {
  button.onclick = () => act(() => api.setTheme(button.dataset.theme, currentState.accent || 'amber'));
}
for (const button of document.querySelectorAll('[data-accent]')) {
  button.onclick = () => act(() => api.setTheme(currentState.theme || 'dark', button.dataset.accent));
}
for (const [id, flag] of [
  ['auto-start-toggle', 'autoStart'],
  ['auto-update-toggle', 'autoUpdate'],
  ['show-sites-toggle', 'showSites'],
  ['companion-toggle', 'companionVisible'],
  ['lan-listen-toggle', 'lanListen'],
]) $(id).onchange = e => act(() => api.setFlag(flag, e.target.checked));

$('companion-next').onclick = () => { tipIdx++; showTip(); };
$('companion-pet').onclick = () => { $('companion-msg').textContent = PETS[petIdx++ % PETS.length]; };
showTip();

$('whats-new-btn').onclick = () => { whatsNewManual = true; render(currentState); };
$('close-whats-new').onclick = () => { whatsNewManual = false; act(() => api.dismissWhatsNew()); };
$('connection').onsubmit = event => { event.preventDefault(); act(() => api.connect($('url').value)); };
act(() => api.state());


