const api = window.tavernka;
const $ = id => document.getElementById(id);
let currentState = {theme: 'dark', accent: 'amber'};
let whatsNewManual = false;

function applyTheme(theme, accent) {
  const el = document.documentElement;
  if (theme && theme !== 'system') el.dataset.theme = theme;
  else delete el.dataset.theme;
  if (accent && accent !== 'amber') el.dataset.accent = accent;
  else delete el.dataset.accent;
}

function render(state) {
  currentState = state;
  applyTheme(state.theme, state.accent);
  $('status').textContent = state.message;
  $('folder').textContent = state.folder || 'Папка ещё не выбрана';
  if (state.version) $('version-label').textContent = `для Windows · ${state.version}`;
  if (document.activeElement !== $('url')) $('url').value = state.url;
  const catalogBtn = $('catalog-tab');
  if (catalogBtn) {
    catalogBtn.textContent = state.catalogNewCount > 0 ? `Каталог · +${state.catalogNewCount}` : 'Каталог';
  }
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-current', button.dataset.tab === state.selected ? 'page' : 'false');
  }
  for (const button of document.querySelectorAll('[data-theme]')) {
    button.setAttribute('aria-current', button.dataset.theme === (state.theme || 'dark') ? 'page' : 'false');
  }
  for (const button of document.querySelectorAll('[data-accent]')) {
    button.setAttribute('aria-current', button.dataset.accent === (state.accent || 'amber') ? 'page' : 'false');
  }
  for (const id of ['choose', 'install', 'start']) $(id).disabled = state.busy || state.running || (id !== 'choose' && !state.folder);
  $('stop').disabled = !state.running;
  $('connection').querySelector('button').disabled = state.busy || state.running;
  const modal = $('whats-new-modal');
  if (modal) modal.hidden = !(whatsNewManual || state.whatsNewPending);
}

async function act(fn) {
  try { const result = await fn(); if (result && result.state) render(result.state); }
  catch { $('status').textContent = 'Действие не выполнено. Попробуйте ещё раз.'; }
}

api.onState(render);
for (const [id, method] of [['choose','chooseFolder'],['install','install'],['start','start'],['stop','stop'],['reload','reload']]) $(id).onclick = () => act(() => api[method]());
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => act(() => api.tab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-theme]')) {
  button.onclick = () => act(() => api.setTheme(button.dataset.theme, currentState.accent || 'amber'));
}
for (const button of document.querySelectorAll('[data-accent]')) {
  button.onclick = () => act(() => api.setTheme(currentState.theme || 'dark', button.dataset.accent));
}
$('whats-new-btn').onclick = () => { whatsNewManual = true; render(currentState); };
$('close-whats-new').onclick = () => { whatsNewManual = false; act(() => api.dismissWhatsNew()); };
$('connection').onsubmit = event => { event.preventDefault(); act(() => api.connect($('url').value)); };
act(() => api.state());

