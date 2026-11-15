const api = window.tavernka;
const $ = id => document.getElementById(id);
function render(state) {
  $('status').textContent = state.message;
  $('folder').textContent = state.folder || 'Папка ещё не выбрана';
  if (document.activeElement !== $('url')) $('url').value = state.url;
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-current', button.dataset.tab === state.selected ? 'page' : 'false');
  for (const id of ['choose', 'install', 'start']) $(id).disabled = state.busy || state.running || (id !== 'choose' && !state.folder);
  $('stop').disabled = !state.running;
  $('connection').querySelector('button').disabled = state.busy || state.running;
}
async function act(fn) {
  try { const result = await fn(); if (result.state) render(result.state); }
  catch { $('status').textContent = 'Действие не выполнено. Попробуйте ещё раз.'; }
}
api.onState(render);
for (const [id, method] of [['choose','chooseFolder'],['install','install'],['start','start'],['stop','stop'],['reload','reload']]) $(id).onclick = () => act(() => api[method]());
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => act(() => api.tab(button.dataset.tab));
$('connection').onsubmit = event => { event.preventDefault(); act(() => api.connect($('url').value)); };
act(() => api.state());
