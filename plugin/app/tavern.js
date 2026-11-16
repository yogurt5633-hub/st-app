// Tavern management tab (#tavern: Presets, Lorebooks, Cards, Extensions, Regexes, Antivirus)
// and Conversion/Export tool (#tools/convert) for SillyTavern.

let ui = null;
let renderExtensionsFn = null;
let mascotRowFn = null;
let backFn = null;

export function setupTavern(helpers, { renderExtensions, mascotRow, back }) {
    ui = helpers;
    renderExtensionsFn = renderExtensions;
    mascotRowFn = mascotRow;
    backFn = back;
}

const TAVERN_TABS = [
    ['presets', 'Пресеты'],
    ['lorebooks', 'Лорбук'],
    ['cards', 'Карточки'],
    ['extensions', 'Расширения'],
    ['regex', 'Регексы'],
    ['antivirus', 'Антивирус'],
];

function saveBase64Download(fileName, mime, base64) {
    if (window.KorrektorFiles?.save) {
        window.KorrektorFiles.save(fileName, mime, base64);
        return;
    }
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
        reader.readAsDataURL(file);
    });
}

async function importAnyFileToTavern(file, expectedType = '') {
    const base64 = await readFileAsBase64(file);
    const r = await ui.api('/convert', { method: 'POST', body: { name: file.name, base64, action: 'install', targetFormat: expectedType }, timeout: 120000 });
    ui.toast(`Установлено: ${r.installed?.where || 'SillyTavern'} → ${r.installed?.name || file.name}`);
}

export async function renderTavern(subTab = '') {
    const { h, put, $ } = ui;
    const view = $('#view');
    const active = TAVERN_TABS.some(([k]) => k === subTab) ? subTab : (ui.storageGet('korrektor.tavernTab') || 'presets');
    ui.storageSet('korrektor.tavernTab', active);
    const nav = h('div', { class: 'filters', role: 'group', 'aria-label': 'Разделы таверны' },
        TAVERN_TABS.map(([key, label]) => h('button', {
            class: 'filter', type: 'button', 'aria-pressed': String(active === key),
            onclick: () => {
                ui.storageSet('korrektor.tavernTab', key);
                if (location.hash !== `#tavern/${key}`) location.hash = `#tavern/${key}`;
                else renderTavern(key);
            },
        }, label)));
    const body = h('div', { class: 'section', style: 'margin-top:8px' }, h('p', { class: 'muted', text: 'Загружаю…' }));
    put(view, nav, body);

    if (active === 'antivirus') return renderExtensionsFn(body);
    if (active === 'presets') return renderTavernPresets(body);
    if (active === 'lorebooks') return renderTavernLorebooks(body);
    if (active === 'cards') return renderTavernCards(body);
    if (active === 'extensions') return renderTavernExtensions(body);
    if (active === 'regex') return renderTavernRegex(body);
}

async function openPresetPrompts(item) {
    const { h } = ui;
    try {
        const detail = await ui.api(`/tavern/presets/detail?name=${encodeURIComponent(item.name)}`);
        const box = h('div', { class: 'rows' }, detail.prompts.map(pr => {
            const toggle = h('input', { type: 'checkbox' });
            toggle.checked = pr.enabled;
            toggle.addEventListener('change', async () => {
                try { await ui.api('/tavern/presets/prompt', { method: 'POST', body: { preset: item.name, identifier: pr.identifier, enabled: toggle.checked } }); }
                catch (e) { ui.toast(e.message, true); }
            });
            const area = h('textarea', { class: 'input', rows: 4, style: 'width:100%;height:auto;padding:8px 10px;margin-top:8px;display:none' });
            area.value = pr.content;
            const saveBtn = h('button', { class: 'btn secondary small', type: 'button', style: 'margin-top:6px;display:none', text: 'Сохранить текст', onclick: async () => {
                try {
                    await ui.api('/tavern/presets/prompt', { method: 'POST', body: { preset: item.name, identifier: pr.identifier, content: area.value } });
                    ui.toast('Промпт сохранён');
                } catch (e) { ui.toast(e.message, true); }
            } });
            return h('div', { class: 'field' },
                h('div', { class: 'field-row' },
                    h('button', { class: 'btn quiet small', type: 'button', style: 'padding:0;text-align:left;flex:1', text: pr.name, onclick: () => {
                        const show = area.style.display === 'none';
                        area.style.display = show ? 'block' : 'none';
                        saveBtn.style.display = show ? 'inline-flex' : 'none';
                    } }),
                    toggle),
                area, saveBtn);
        }));
        ui.openSheet(`Промпты: ${item.name}`, [h('p', { class: 'small muted', text: 'Нажмите на название промпта, чтобы изменить текст' }), box]);
    } catch (e) { ui.toast(e.message, true); }
}

async function renderTavernPresets(container) {
    const { h, put } = ui;
    let data;
    try { data = await ui.api('/tavern/presets'); } catch (e) { put(container, h('p', { text: e.message })); return; }
    if (!container.isConnected) return;
    const p = data.params || {};
    const maxContext = h('input', { class: 'input mono', type: 'number', min: 512, step: 512, value: p.maxContext || 4096, style: 'width:110px;text-align:right', 'aria-label': 'Контекст, токенов' });
    const maxTokens = h('input', { class: 'input mono', type: 'number', min: 16, step: 64, value: p.maxTokens || 300, style: 'width:110px;text-align:right', 'aria-label': 'Ответ, токенов' });
    const temp = h('input', { class: 'input mono', type: 'number', min: 0, max: 2, step: 0.05, value: p.temp ?? 1, style: 'width:90px;text-align:right', 'aria-label': 'Температура' });
    const stream = h('input', { type: 'checkbox' });
    stream.checked = Boolean(p.stream);
    const saveParams = async () => {
        try {
            await ui.api('/tavern/presets/params', { method: 'POST', body: { maxContext: Number(maxContext.value), maxTokens: Number(maxTokens.value), temp: Number(temp.value), stream: stream.checked } });
            ui.toast('Параметры сохранены в таверне');
        } catch (e) { ui.toast(e.message, true); }
    };
    for (const el of [maxContext, maxTokens, temp, stream]) el.addEventListener('change', saveParams);

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        try { await importAnyFileToTavern(f); renderTavernPresets(container); } catch (e) { ui.toast(e.message, true); }
    });

    put(container,
        h('p', { class: 'small muted', text: 'Настройка параметров и промптов напрямую в SillyTavern' }),
        h('div', { class: 'rows', style: 'margin-bottom:16px' },
            h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Контекст, токенов' }), maxContext)),
            h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Ответ, токенов' }), maxTokens)),
            h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Температура' }), temp)),
            h('label', { class: 'check-row' }, stream, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Потоковый ответ (стриминг)' })))),
        h('div', { class: 'card-actions', style: 'margin-bottom:12px' },
            h('button', { class: 'btn secondary small', type: 'button', text: 'Импортировать пресет (.json)', onclick: () => fileInput.click() }), fileInput),
        data.items.length ? h('div', { class: 'list' }, data.items.map(item => h('article', { class: 'card' },
            h('div', { class: 'field-row' },
                h('h2', { class: 'card-title', style: 'margin:0', text: item.name }),
                item.active ? h('span', { class: 'badge uncensored', text: 'Активен' }) : null),
            h('div', { class: 'card-actions' },
                item.active ? null : h('button', { class: 'btn primary small', type: 'button', text: 'Выбрать', onclick: async () => {
                    try { await ui.api('/tavern/presets/activate', { method: 'POST', body: { name: item.name } }); ui.toast(`Пресет «${item.name}» включён`); renderTavernPresets(container); }
                    catch (e) { ui.toast(e.message, true); }
                } }),
                h('button', { class: 'btn secondary small', type: 'button', text: 'Промпты', onclick: () => openPresetPrompts(item) }),
                h('a', { class: 'btn secondary small', href: `${ui.BASE}/catalog/export?type=preset&file=${encodeURIComponent(item.file)}`, download: item.file, text: 'Скачать' }),
                h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить', onclick: async () => {
                    const ok = await ui.confirmDialog({ title: `Удалить пресет «${item.name}»?`, text: 'Копия останется в резервных копиях Тавернки', ok: 'Удалить', danger: true });
                    if (!ok) return;
                    try { await ui.api('/tavern/presets/delete', { method: 'POST', body: { name: item.name } }); renderTavernPresets(container); }
                    catch (e) { ui.toast(e.message, true); }
                } })))))
            : h('p', { class: 'muted', text: 'Пресетов пока нет' }));
}

async function openLorebookEntries(item) {
    const { h } = ui;
    try {
        const detail = await ui.api(`/tavern/lorebooks/detail?name=${encodeURIComponent(item.name)}`);
        const drawSheet = (entries) => {
            const addBtn = h('button', { class: 'btn primary small', type: 'button', text: '+ Новая запись', onclick: async () => {
                const comment = prompt('Название записи (комментарий):', '');
                if (comment === null) return;
                const key = prompt('Ключевые слова через запятую:', '');
                if (key === null) return;
                const content = prompt('Текст записи:', '');
                if (content === null) return;
                const updated = await ui.api('/tavern/lorebooks/entry', { method: 'POST', body: { world: item.name, comment, key, content } });
                drawSheet(updated.entries);
            } });
            const rows = h('div', { class: 'rows', style: 'margin-top:12px' }, entries.map(en => {
                const enabled = h('input', { type: 'checkbox' });
                enabled.checked = !en.disable;
                enabled.addEventListener('change', async () => {
                    await ui.api('/tavern/lorebooks/entry', { method: 'POST', body: { world: item.name, uid: en.uid, disable: !enabled.checked } });
                });
                const keyInput = h('input', { class: 'input', type: 'text', value: en.key.join(', '), placeholder: 'Ключи через запятую', style: 'width:100%;margin-top:8px;display:none' });
                const area = h('textarea', { class: 'input', rows: 4, style: 'width:100%;height:auto;padding:8px 10px;margin-top:6px;display:none' });
                area.value = en.content;
                const actions = h('div', { class: 'card-actions', style: 'display:none' },
                    h('button', { class: 'btn primary small', type: 'button', text: 'Сохранить', onclick: async () => {
                        await ui.api('/tavern/lorebooks/entry', { method: 'POST', body: { world: item.name, uid: en.uid, key: keyInput.value, content: area.value } });
                        ui.toast('Запись сохранена');
                    } }),
                    h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить', onclick: async () => {
                        const updated = await ui.api('/tavern/lorebooks/entry-delete', { method: 'POST', body: { world: item.name, uid: en.uid } });
                        drawSheet(updated.entries);
                    } }));
                return h('div', { class: 'field' },
                    h('div', { class: 'field-row' },
                        h('button', { class: 'btn quiet small', type: 'button', style: 'padding:0;text-align:left;flex:1', text: en.label || `Запись #${en.uid}`, onclick: () => {
                            const show = area.style.display === 'none';
                            keyInput.style.display = show ? 'block' : 'none';
                            area.style.display = show ? 'block' : 'none';
                            actions.style.display = show ? 'flex' : 'none';
                        } }),
                        enabled),
                    keyInput, area, actions);
            }));
            ui.openSheet(`Лорбук: ${item.name}`, [addBtn, entries.length ? rows : h('p', { class: 'muted', style: 'margin-top:12px', text: 'Записей пока нет' })]);
        };
        drawSheet(detail.entries);
    } catch (e) { ui.toast(e.message, true); }
}

async function renderTavernLorebooks(container) {
    const { h, put } = ui;
    let data;
    try { data = await ui.api('/tavern/lorebooks'); } catch (e) { put(container, h('p', { text: e.message })); return; }
    if (!container.isConnected) return;
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        try { await importAnyFileToTavern(f); renderTavernLorebooks(container); } catch (e) { ui.toast(e.message, true); }
    });
    put(container,
        h('p', { class: 'small muted', text: 'Включите лорбук переключателем, чтобы он действовал глобально во всех чатах таверны' }),
        h('div', { class: 'card-actions', style: 'margin-bottom:12px' },
            h('button', { class: 'btn secondary small', type: 'button', text: 'Импортировать лорбук (.json)', onclick: () => fileInput.click() }), fileInput),
        data.items.length ? h('div', { class: 'list' }, data.items.map(item => {
            const toggle = h('input', { type: 'checkbox', 'aria-label': `Включить ${item.name}` });
            toggle.checked = item.active;
            toggle.addEventListener('change', async () => {
                try {
                    await ui.api('/tavern/lorebooks/toggle', { method: 'POST', body: { name: item.name, active: toggle.checked } });
                    ui.toast(toggle.checked ? `Лорбук «${item.name}» включён глобально` : `Лорбук «${item.name}» выключен`);
                } catch (e) { ui.toast(e.message, true); toggle.checked = !toggle.checked; }
            });
            return h('article', { class: 'card' },
                h('div', { class: 'field-row' },
                    h('div', {},
                        h('h2', { class: 'card-title', style: 'margin:0', text: item.name }),
                        h('p', { class: 'small muted', style: 'margin:2px 0 0', text: `Записей: ${item.enabledEntries} из ${item.entries}` })),
                    toggle),
                h('div', { class: 'card-actions' },
                    h('button', { class: 'btn secondary small', type: 'button', text: 'Записи', onclick: () => openLorebookEntries(item) }),
                    h('a', { class: 'btn secondary small', href: `${ui.BASE}/catalog/export?type=lorebook&file=${encodeURIComponent(item.file)}`, download: item.file, text: 'Скачать' }),
                    h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить', onclick: async () => {
                        const ok = await ui.confirmDialog({ title: `Удалить лорбук «${item.name}»?`, text: 'Копия останется в резервных копиях Тавернки', ok: 'Удалить', danger: true });
                        if (!ok) return;
                        try { await ui.api('/tavern/lorebooks/delete', { method: 'POST', body: { name: item.name } }); renderTavernLorebooks(container); }
                        catch (e) { ui.toast(e.message, true); }
                    } })));
        })) : h('p', { class: 'muted', text: 'Лорбуков пока нет' }));
}

async function editTavernCard(item, worlds, container) {
    const { h } = ui;
    try {
        const d = await ui.api(`/tavern/cards/detail?avatar=${encodeURIComponent(item.avatar)}`);
        const makeArea = (val, rows = 4) => {
            const a = h('textarea', { class: 'input', rows, style: 'width:100%;height:auto;padding:8px 10px' });
            a.value = val || '';
            return a;
        };
        const nameIn = h('input', { class: 'input', type: 'text', value: d.name, style: 'width:100%' });
        const worldSel = h('select', { class: 'select', style: 'width:100%' },
            h('option', { value: '', text: 'Без привязанного лорбука' }),
            worlds.map(w => h('option', { value: w, text: w })));
        worldSel.value = d.world || '';
        const desc = makeArea(d.description, 5);
        const pers = makeArea(d.personality, 3);
        const scen = makeArea(d.scenario, 3);
        const first = makeArea(d.first_mes, 5);
        const depth = makeArea(d.depth_prompt, 3);
        const save = h('button', { class: 'btn primary', type: 'button', text: 'Сохранить карточку', onclick: async () => {
            try {
                await ui.api('/tavern/cards/save', {
                    method: 'POST',
                    body: { avatar: item.avatar, name: nameIn.value, world: worldSel.value, description: desc.value, personality: pers.value, scenario: scen.value, first_mes: first.value, depth_prompt: depth.value },
                });
                ui.toast('Карточка сохранена');
                renderTavernCards(container);
            } catch (e) { ui.toast(e.message, true); }
        } });
        const fld = (label, node) => h('div', { class: 'field' }, h('span', { class: 'label', text: label }), node);
        ui.openSheet(`Карточка: ${d.name}`, [
            h('div', { class: 'rows' },
                fld('Имя персонажа', nameIn),
                fld('Лорбук персонажа', worldSel),
                fld('Описание (Description)', desc),
                fld('Характер (Personality)', pers),
                fld('Сценарий (Scenario)', scen),
                fld('Первое сообщение (Greeting)', first),
                fld('Промпт на глубине (Character Note)', depth)),
        ], [save]);
    } catch (e) { ui.toast(e.message, true); }
}

async function renderTavernCards(container) {
    const { h, put } = ui;
    let cards = [];
    let worlds = [];
    try {
        const [cRes, wRes] = await Promise.all([ui.api('/cards'), ui.api('/worlds')]);
        cards = cRes.items || [];
        worlds = wRes.items || [];
    } catch (e) { put(container, h('p', { text: e.message })); return; }
    if (!container.isConnected) return;

    const fileInput = h('input', { type: 'file', accept: '.png,.json,image/png,application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        try { await importAnyFileToTavern(f); renderTavernCards(container); } catch (e) { ui.toast(e.message, true); }
    });

    let q = '';
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Найти персонажа', style: 'width:100%;margin-bottom:12px' });
    const listBox = h('div', { class: 'list' });
    const draw = () => {
        const filtered = q ? cards.filter(c => c.name.toLowerCase().includes(q) || (c.world || '').toLowerCase().includes(q)) : cards;
        put(listBox, filtered.length ? filtered.slice(0, 150).map(item => h('article', { class: 'card' },
            h('h2', { class: 'card-title', style: 'margin:0', text: item.name }),
            h('p', { class: 'small muted', style: 'margin:2px 0 0', text: item.world ? `Лорбук: ${item.world}` : item.avatar }),
            h('div', { class: 'card-actions' },
                h('button', { class: 'btn primary small', type: 'button', text: 'Изменить', onclick: () => editTavernCard(item, worlds, container) }),
                h('a', { class: 'btn secondary small', href: `#card/${encodeURIComponent(item.avatar)}`, text: 'Здоровье' }),
                h('a', { class: 'btn secondary small', href: `${ui.BASE}/catalog/export?type=card&file=${encodeURIComponent(item.avatar)}`, download: item.avatar, text: 'Скачать PNG' }),
                h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить', onclick: async () => {
                    const ok = await ui.confirmDialog({ title: `Удалить карточку «${item.name}»?`, text: 'Копия PNG останется в резервных копиях Тавернки', ok: 'Удалить', danger: true });
                    if (!ok) return;
                    try { await ui.api('/tavern/cards/delete', { method: 'POST', body: { avatar: item.avatar } }); renderTavernCards(container); }
                    catch (e) { ui.toast(e.message, true); }
                } }))))
            : h('p', { class: 'muted', text: 'Персонажей не найдено' }));
    };
    search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); draw(); });
    draw();
    put(container,
        h('div', { class: 'card-actions', style: 'margin-bottom:12px' },
            h('button', { class: 'btn secondary small', type: 'button', text: 'Импортировать карточку (.png / .json)', onclick: () => fileInput.click() }), fileInput),
        cards.length > 5 ? search : null,
        listBox);
}

async function renderTavernExtensions(container) {
    const { h, put } = ui;
    let data;
    try { data = await ui.api('/tavern/extensions'); } catch (e) { put(container, h('p', { text: e.message })); return; }
    if (!container.isConnected) return;
    const fileInput = h('input', { type: 'file', accept: '.zip,application/zip,application/x-zip-compressed', hidden: true });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        try { await importAnyFileToTavern(f); renderTavernExtensions(container); } catch (e) { ui.toast(e.message, true); }
    });
    put(container,
        h('p', { class: 'small muted', text: 'Включайте и отключайте установленные расширения SillyTavern или устанавливайте новые из ZIP' }),
        h('div', { class: 'card-actions', style: 'margin-bottom:12px' },
            h('button', { class: 'btn secondary small', type: 'button', text: 'Установить расширение (.zip)', onclick: () => fileInput.click() }), fileInput),
        data.items.length ? h('div', { class: 'list' }, data.items.map(item => {
            const toggle = h('input', { type: 'checkbox', 'aria-label': `Включить ${item.name}` });
            toggle.checked = item.enabled;
            toggle.addEventListener('change', async () => {
                try {
                    await ui.api('/tavern/extensions/toggle', { method: 'POST', body: { id: item.id, enabled: toggle.checked } });
                    ui.toast(toggle.checked ? `Расширение «${item.name}» включено` : `Расширение «${item.name}» выключено`);
                } catch (e) { ui.toast(e.message, true); toggle.checked = !toggle.checked; }
            });
            return h('article', { class: 'card' },
                h('div', { class: 'field-row' },
                    h('div', {},
                        h('h2', { class: 'card-title', style: 'margin:0', text: item.name }),
                        h('p', { class: 'small muted', style: 'margin:2px 0 0', text: [item.version ? `v${item.version}` : '', item.author, item.id].filter(Boolean).join(' · ') })),
                    toggle),
                h('div', { class: 'card-actions' },
                    item.scope === 'user' ? h('a', { class: 'btn secondary small', href: `${ui.BASE}/tavern/extensions/export?id=${encodeURIComponent(item.id)}`, download: `${item.id}.zip`, text: 'Скачать ZIP' }) : null,
                    item.scope === 'user' && !item.builtinCompanion ? h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить', onclick: async () => {
                        const ok = await ui.confirmDialog({ title: `Удалить расширение «${item.name}»?`, text: 'Копия папки сохранится в резервных копиях Тавернки', ok: 'Удалить', danger: true });
                        if (!ok) return;
                        try { await ui.api('/tavern/extensions/delete', { method: 'POST', body: { id: item.id } }); renderTavernExtensions(container); }
                        catch (e) { ui.toast(e.message, true); }
                    } }) : null));
        })) : h('p', { class: 'muted', text: 'Установленных расширений пока нет' }));
}

function openRegexEditor(item, container) {
    const { h } = ui;
    const nameIn = h('input', { class: 'input', type: 'text', value: item?.scriptName || '', placeholder: 'Название правила', style: 'width:100%' });
    const findIn = h('input', { class: 'input mono', type: 'text', value: item?.findRegex || '', placeholder: '/шаблон/g', style: 'width:100%' });
    const repIn = h('textarea', { class: 'input mono', rows: 3, placeholder: 'Чем заменить (пусто — удалить)', style: 'width:100%;height:auto;padding:8px 10px' });
    repIn.value = item?.replaceString || '';
    const mdOnly = h('input', { type: 'checkbox' });
    mdOnly.checked = Boolean(item?.markdownOnly);
    const promptOnly = h('input', { type: 'checkbox' });
    promptOnly.checked = Boolean(item?.promptOnly);
    const save = h('button', { class: 'btn primary', type: 'button', text: 'Сохранить', onclick: async () => {
        try {
            await ui.api('/tavern/regex/save', {
                method: 'POST',
                body: { index: item?.index, scriptName: nameIn.value, findRegex: findIn.value, replaceString: repIn.value, markdownOnly: mdOnly.checked, promptOnly: promptOnly.checked },
            });
            ui.toast('Правило Regex сохранено');
            renderTavernRegex(container);
        } catch (e) { ui.toast(e.message, true); }
    } });
    ui.openSheet(item ? `Регекс: ${item.scriptName}` : 'Новый регекс', [
        h('div', { class: 'rows' },
            h('div', { class: 'field' }, h('span', { class: 'label', text: 'Название' }), nameIn),
            h('div', { class: 'field' }, h('span', { class: 'label', text: 'Найти (findRegex)' }), findIn),
            h('div', { class: 'field' }, h('span', { class: 'label', text: 'Заменить на (replaceString)' }), repIn),
            h('label', { class: 'check-row' }, mdOnly, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Только на экране (не менять промпт)' }))),
            h('label', { class: 'check-row' }, promptOnly, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Только в промпте (не менять чат на экране)' })))),
    ], [save]);
}

async function renderTavernRegex(container) {
    const { h, put } = ui;
    let data;
    try { data = await ui.api('/tavern/regex'); } catch (e) { put(container, h('p', { text: e.message })); return; }
    if (!container.isConnected) return;

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        try { await importAnyFileToTavern(f); renderTavernRegex(container); } catch (e) { ui.toast(e.message, true); }
    });

    put(container,
        h('p', { class: 'small muted', text: 'Глобальные правила Regex вашей таверны: убирают разметку и оформляют текст' }),
        h('div', { class: 'card-actions', style: 'margin-bottom:12px' },
            h('button', { class: 'btn primary small', type: 'button', text: '+ Новый регекс', onclick: () => openRegexEditor(null, container) }),
            h('button', { class: 'btn secondary small', type: 'button', text: 'Импорт (.json)', onclick: () => fileInput.click() }),
            data.items.length ? h('a', { class: 'btn secondary small', href: `${ui.BASE}/tavern/regex/export`, download: 'sillytavern-regex.json', text: 'Экспорт всех' }) : null,
            fileInput),
        data.items.length ? h('div', { class: 'list' }, data.items.map(item => {
            const toggle = h('input', { type: 'checkbox', 'aria-label': `Включить ${item.scriptName}` });
            toggle.checked = !item.disabled;
            toggle.addEventListener('change', async () => {
                try { await ui.api('/tavern/regex/save', { method: 'POST', body: { index: item.index, disabled: !toggle.checked } }); }
                catch (e) { ui.toast(e.message, true); toggle.checked = !toggle.checked; }
            });
            return h('article', { class: 'card' },
                h('div', { class: 'field-row' },
                    h('div', { style: 'min-width:0;flex:1' },
                        h('h2', { class: 'card-title', style: 'margin:0', text: item.scriptName }),
                        h('p', { class: 'small mono muted', style: 'margin:2px 0 0;overflow-wrap:anywhere', text: item.findRegex })),
                    toggle),
                h('div', { class: 'card-actions' },
                    h('button', { class: 'btn secondary small', type: 'button', text: 'Изменить', onclick: () => openRegexEditor(item, container) }),
                    h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить', onclick: async () => {
                        const ok = await ui.confirmDialog({ title: `Удалить регекс «${item.scriptName}»?`, text: 'Правило уберётся из глобальных регексов таверны', ok: 'Удалить', danger: true });
                        if (!ok) return;
                        try { await ui.api('/tavern/regex/delete', { method: 'POST', body: { index: item.index } }); renderTavernRegex(container); }
                        catch (e) { ui.toast(e.message, true); }
                    } })));
        })) : h('p', { class: 'muted', text: 'Глобальных регексов пока нет' }));
}

export async function renderConvert() {
    const { h, put, $ } = ui;
    const view = $('#view');
    const resultBox = h('div', { class: 'section' });
    const fileInput = h('input', { type: 'file', accept: '.png,.json,.zip,image/png,application/json,application/zip,application/x-zip-compressed', hidden: true });

    const inspectFile = async (file) => {
        put(resultBox, h('p', { class: 'muted', text: 'Анализирую и конвертирую файл…' }));
        try {
            const base64 = await readFileAsBase64(file);
            const info = await ui.api('/convert', { method: 'POST', body: { name: file.name, base64, action: 'inspect' }, timeout: 120000 });
            put(resultBox,
                h('article', { class: 'card' },
                    h('h2', { class: 'card-title', text: info.title || file.name }),
                    h('p', { class: 'card-summary', text: info.summary }),
                    h('div', { class: 'card-actions' },
                        info.canInstall ? h('button', { class: 'btn primary', type: 'button', text: 'Установить в SillyTavern', onclick: async (e) => {
                            e.currentTarget.disabled = true;
                            try {
                                const r = await ui.api('/convert', { method: 'POST', body: { name: file.name, base64, action: 'install', targetFormat: info.canInstallLorebook ? 'with-lorebook' : '' }, timeout: 120000 });
                                ui.toast(`Установлено: ${r.installed?.where} → ${r.installed?.name}${r.loreInstalled ? ` (+ лорбук ${r.loreInstalled.name})` : ''}`);
                                e.currentTarget.textContent = '✓ Установлено в SillyTavern';
                            } catch (err) {
                                ui.toast(err.message, true);
                                e.currentTarget.disabled = false;
                            }
                        } }) : null,
                        ...(info.formats || []).map(fmt => h('button', { class: 'btn secondary', type: 'button', text: `Скачать: ${fmt.label}`, onclick: async () => {
                            try {
                                const out = await ui.api('/convert', { method: 'POST', body: { name: file.name, base64, action: 'download', targetFormat: fmt.id }, timeout: 120000 });
                                saveBase64Download(out.fileName, out.mime, out.base64);
                                ui.toast(`Готово: ${out.fileName}`);
                            } catch (err) { ui.toast(err.message, true); }
                        } })))));
        } catch (error) {
            put(resultBox, h('p', { class: 'small', style: 'color:var(--del-text)', text: error.message }));
        }
    };

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) inspectFile(fileInput.files[0]);
        fileInput.value = '';
    });

    put(view,
        backFn('#tools', 'Ещё'),
        h('div', { class: 'section' },
            mascotRowFn('books', 'Конвертация и перенос в SillyTavern', 'Выберите карточку (PNG или JSON V1/V2/V3), лорбук, пресет, регекс или ZIP-расширение: Тавернка приведёт файл к формату SillyTavern, вытащит вшитые лорбуки/регексы и позволит сразу установить в таверну или скачать'),
            h('div', { class: 'card-actions' },
                h('button', { class: 'btn primary', type: 'button', text: 'Выбрать файл (PNG / JSON / ZIP)', onclick: () => fileInput.click() }),
                fileInput)),
        resultBox,
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Управление и выгрузка из запущенной таверны' }),
            h('div', { class: 'rows' },
                h('a', { class: 'row row-link', href: '#tavern/cards' }, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Карточки персонажей' }), h('span', { class: 'row-sub', text: 'Скачать PNG, изменить поля или импортировать' })), h('span', { class: 'chev', text: '›' })),
                h('a', { class: 'row row-link', href: '#tavern/lorebooks' }, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Лорбуки (World Info)' }), h('span', { class: 'row-sub', text: 'Скачать JSON, включить или изменить записи' })), h('span', { class: 'chev', text: '›' })),
                h('a', { class: 'row row-link', href: '#tavern/presets' }, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Пресеты Chat Completion' }), h('span', { class: 'row-sub', text: 'Скачать очищенный пресет или настроить промпты' })), h('span', { class: 'chev', text: '›' })),
                h('a', { class: 'row row-link', href: '#tavern/extensions' }, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Расширения (упаковка в ZIP)' }), h('span', { class: 'row-sub', text: 'Скачать установленное расширение готовым ZIP-архивом' })), h('span', { class: 'chev', text: '›' })),
                h('a', { class: 'row row-link', href: '#tavern/regex' }, h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Регексы (Regex)' }), h('span', { class: 'row-sub', text: 'Экспортировать все правила Regex в один JSON' })), h('span', { class: 'chev', text: '›' })))));
}








