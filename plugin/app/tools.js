import { CATALOG_LANGUAGES, matchesCatalogFilters } from './catalog-filters.js';
import { setupTavern, renderTavern, renderConvert } from './tavern.js';
export { renderTavern, renderConvert };

// Корректор: the "Ещё" tab and the tools behind it — spending, card health,
// full backup, import by link, catalog, key check — plus the chat sheet parts
// "Сжать чат" and "Итоги сессии". Helpers come from app.js through setup().

let ui = null;

export function setup(helpers) {
    ui = helpers;
    setupTavern(helpers, { renderExtensions, mascotRow, back });
}

const TOKEN_KINDS = ['context', 'preset_bloat', 'prompt_reasoning', 'prompt_html', 'advice', 'lore_keyed', 'lore_card_dup', 'lore_bloat', 'card_bloat'];

// The approved illustration is shared across themes; it is not a status indicator.
export function refreshMascots() {
    for (const img of document.querySelectorAll('img.mascot[data-mascot]')) {
        if (img.getAttribute('src') !== 'img/mascot.png') img.setAttribute('src', 'img/mascot.png');
    }
}

export function mascot(name, size = 120, alt = '') {
    if (size < 120 || !['wave', 'sleep', 'books'].includes(name)) return null;
    const { h } = ui;
    return h('button', { class: 'mascot-button', type: 'button', 'aria-label': 'Совет Тавернки', onclick: () => {
        ui.openSheet('Совет Тавернки', h('div', {},
            h('p', { text: name === 'books' ? 'Пусто? Попробуй другую вкладку каталога или сбрось фильтры. Проверить дополнения можно во вкладке «Таверна → Антивирус».' : 'Оптимизация пока отдыхает. Перевод сообщений, каталог и резервные копии работают.' }),
            h('div', { class: 'card-actions' },
                h('a', { class: 'btn secondary', href: '#tools/catalog', text: 'Каталог' }),
                h('a', { class: 'btn secondary', href: '#tools/backup', text: 'Резервные копии' }))));
    } }, h('img', { class: 'mascot', src: 'img/mascot.png', 'data-mascot': name, width: size, height: size, alt, loading: 'lazy' }));
}

function back(href, title) {
    return ui.h('a', { class: 'back-link', href }, '‹ ', title);
}

function money(value) {
    if (value === null || value === undefined) return '';
    if (value < 0.01) return '<$0.01';
    return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function bytes(n) {
    if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
    if (n > 1024 * 1024) return `${Math.round(n / 1024 / 1024)} МБ`;
    return `${Math.max(1, Math.round(n / 1024))} КБ`;
}

async function waitJob(job, onTick) {
    let current = job;
    while (current && current.status === 'running') {
        await new Promise(r => setTimeout(r, 1200));
        current = await ui.api(`/jobs/${job.id}`);
        onTick?.(current);
    }
    return current;
}

export function inApp() {
    return /KorrektorApp\//.test(navigator.userAgent);
}

// ---------- the "Ещё" tab ----------

export function renderTools() {
    const { h, put, $ } = ui;
    const row = (href, title, sub) => h('a', { class: 'row row-link', href },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: title }), h('span', { class: 'row-sub', text: sub })),
        h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
    put($('#view'),
        h('div', { class: 'rows' },
            row('#tools/convert', 'Конвертация для SillyTavern', 'Карточки, лорбуки, пресеты, регексы и расширения — перенос и скачивание в формате таверны'),
            row('#tools/sync', 'Связь с ПК', 'Чаты, карточки и лорбуки одинаковые на телефоне и компьютере'),
            row('#tools/spend', 'Расходы', 'Сколько токенов и денег ушло, сброс статистики и откат настроек'),
            row('#tools/backup', 'Резервная копия', 'Чаты, карточки, лорбуки и настройки в одном файле')));
}

// ---------- spending ----------

export async function renderSpend() {
    const { h, put, $, fmt, plural, state } = ui;
    const view = $('#view');
    const days = Number(ui.storageGet('korrektor.spendDays')) || 7;
    put(view, back('#tools', 'Ещё'), h('p', { class: 'muted', text: 'Считаю расходы' }));
    let data;
    try {
        data = await ui.api(`/usage?days=${days}`);
    } catch (error) {
        put(view, back('#tools', 'Ещё'), h('div', { class: 'empty' }, h('h2', { text: 'Не удалось посчитать' }), h('p', { text: error.message })));
        return;
    }
    const total = data.total.roleplay.input + data.total.roleplay.output + data.total.korrektor.input + data.total.korrektor.output;
    const spent = data.total.roleplay.cost + data.total.korrektor.cost;
    const today = data.byDay.at(-1) || { roleplay: 0, korrektor: 0, cost: 0 };
    const max = Math.max(1, ...data.byDay.map(d => d.roleplay + d.korrektor));
    const label = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' });

    const editPrice = async (m) => {
        const input = prompt(`Цена ${m.model} за 1 млн входных токенов, $ (0 — не считать)`, m.price?.input ?? '');
        if (input === null) return;
        const output = prompt(`Цена ${m.model} за 1 млн токенов ответа, $`, m.price?.output ?? '');
        if (output === null) return;
        await ui.api('/usage/price', { method: 'POST', body: { model: m.model, input: Number(input.replace(',', '.')), output: Number(output.replace(',', '.')) } });
        renderSpend();
    };

    put(view,
        back('#tools', 'Ещё'),
        h('div', { class: 'filters' }, [[7, 'Неделя'], [30, '30 дней']].map(([v, text]) =>
            h('button', { class: 'filter', type: 'button', 'aria-pressed': String(days === v), onclick: () => { ui.storageSet('korrektor.spendDays', String(v)); renderSpend(); } }, text))),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Сегодня' }),
            h('div', {}, h('span', { class: 'big', text: fmt(today.roleplay + today.korrektor) }), h('span', { class: 'secondary', text: ` токенов${today.cost ? ` · ≈${money(today.cost)}` : ''}` })),
            h('h3', { class: 'section-title', style: 'margin-top:16px', text: days === 7 ? 'За неделю' : 'За 30 дней' }),
            h('div', {}, h('span', { class: 'big', text: fmt(total) }), h('span', { class: 'secondary', text: ` токенов${spent ? ` · ≈${money(spent)}` : ''}` })),
            h('p', { class: 'small muted', style: 'margin:4px 0 0', text: `Ролёвка: ${fmt(data.total.roleplay.input + data.total.roleplay.output)} в ${data.total.roleplay.calls} ${plural(data.total.roleplay.calls, 'запросе', 'запросах', 'запросах')}. Проверки Корректора: ${fmt(data.total.korrektor.input + data.total.korrektor.output)}` }),
            h('div', { class: 'daybars', role: 'img', 'aria-label': 'Токены по дням' }, data.byDay.map(d => h('div', { class: 'daybar' },
                h('div', { class: 'daybar-stack' },
                    h('span', { class: 'daybar-k', style: `height:${(d.korrektor / max) * 100}%` }),
                    h('span', { class: 'daybar-r', style: `height:${(d.roleplay / max) * 100}%` })),
                h('span', { class: 'daybar-label', text: days === 7 ? label(d.day) : '' })))),
            h('div', { class: 'legend' },
                h('span', { class: 'small secondary' }, h('span', { class: 'swatch r' }), ' ролёвка'),
                h('span', { class: 'small secondary' }, h('span', { class: 'swatch k' }), ' проверки Корректора'))),
        data.expensive.length ? h('div', { class: 'section' },
            mascotRow('squeeze', 'Дорогие чаты', `Каждый запрос в этих чатах отправляет больше ${fmt(data.expensiveTokens)} токенов. «Сжать чат» подскажет, что убрать`),
            h('div', { class: 'rows' }, data.expensive.map(e => h('a', { class: 'row row-link', href: `#compress/${encodeURIComponent(e.chatId)}` },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: e.title }), h('span', { class: 'row-sub', text: `${e.model} · ${ui.when(e.at)}` })),
                h('span', { class: 'row-side accent', text: `${fmt(e.tokens)} / запрос` }))))) : null,
        data.models.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'По моделям' }),
            h('div', { class: 'rows' }, data.models.map(m => h('button', { class: 'row row-link', type: 'button', onclick: () => editPrice(m) },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: m.model }),
                    h('span', { class: 'row-sub', text: m.price ? `$${m.price.input} / $${m.price.output} за 1 млн · цена: ${m.price.from}` : 'цена не задана: нажмите, чтобы указать' })),
                h('span', { class: 'row-side', text: m.cost !== null ? `≈${money(m.cost)}` : fmt(m.input + m.output) })))),
            data.unpriced ? h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Деньги считаются только для моделей с известной ценой: OpenRouter публикует свои цены, для остальных их можно вписать. Это оценка, точную сумму показывает сам провайдер' }) : null) : null,
        data.chats.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Больше всего токенов' }),
            h('div', { class: 'rows' }, data.chats.slice(0, 8).map(c => h('a', { class: 'row row-link', href: `#chat/${encodeURIComponent(c.chatId)}` },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: c.title }), h('span', { class: 'row-sub', text: `${c.calls} ${plural(c.calls, 'запрос', 'запроса', 'запросов')}` })),
                h('span', { class: 'row-side', text: c.cost ? `≈${money(c.cost)}` : fmt(c.tokens) }))))) : null,
        !total ? h('div', { class: 'empty' }, mascot('sleep', 140),
            h('h2', { text: 'Пока ничего не потрачено' }),
            h('p', { text: 'Расходы ролёвки считаются после каждого ответа, если в SillyTavern стоит расширение «Корректор: синхронизация». Проверки Корректора считаются сами' })) : null,
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Управление статистикой и настройками' }),
            h('div', { class: 'card-actions' },
                h('button', { class: 'btn secondary', type: 'button', text: 'Сбросить статистику', onclick: async () => {
                    const ok = await ui.confirmDialog({ title: 'Сбросить статистику расходов?', text: 'Счётчики токенов по дням, моделям и чатам обнулятся. Указанные вами цены моделей останутся', ok: 'Сбросить', danger: true });
                    if (!ok) return;
                    await ui.api('/usage/reset', { method: 'POST' });
                    ui.toast('Статистика расходов сброшена');
                    renderSpend();
                } }),
                h('button', { class: 'btn quiet', type: 'button', text: 'Откат до заводских настроек', onclick: async () => {
                    const ok = await ui.confirmDialog({ title: 'Вернуть заводские настройки?', text: 'Настройки Тавернки, глоссарий, скрытые виды замечаний и статистика расходов вернутся к исходным значениям. Чаты, карточки и лорбуки SillyTavern не затрагиваются', ok: 'Сбросить всё', danger: true });
                    if (!ok) return;
                    ui.state.settings = await ui.api('/settings/reset', { method: 'POST' });
                    ui.toast('Настройки возвращены к заводским');
                    renderSpend();
                } }))));
}

function mascotRow(name, title, text) {
    const { h } = ui;
    return h('div', { class: 'with-mascot' }, mascot(name, 64),
        h('div', {}, h('h3', { class: 'section-title', text: title }), h('p', { class: 'small secondary', style: 'margin:0', text })));
}

// ---------- card health ----------

function scoreTag(score) {
    return ui.h('span', { class: `score ${score >= 80 ? 'good' : score >= 50 ? 'mid' : 'low'}`, text: String(score) });
}

export async function renderCardsHealth() {
    const { h, put, $, fmt } = ui;
    const view = $('#view');
    const top = ui.optimizationSwitch ? ui.optimizationSwitch('cards') : back('#feed', 'Оптимизация');
    put(view, top, h('p', { class: 'muted', text: 'Читаю карточки' }));
    let items;
    try {
        items = (await ui.api('/cards-health')).items;
    } catch (error) {
        put(view, top, h('div', { class: 'empty' }, h('h2', { text: 'Не удалось прочитать карточки' }), h('p', { text: error.message })));
        return;
    }
    put(view, top,
        h('p', { class: 'small muted', text: 'Сначала те, что стоит поправить. Оценка без модели: размер, пустые поля, лишняя разметка, повторы и открытые замечания' }),
        items.length ? h('div', { class: 'rows' }, items.map(c => h('a', { class: 'row row-link', href: `#card/${encodeURIComponent(c.avatar)}` },
            h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: c.name }), h('span', { class: 'row-sub', text: `${c.verdict} · ≈${fmt(c.tokens)} токенов` })),
            scoreTag(c.score))))
            : h('div', { class: 'empty' }, mascot('sleep', 140), h('h2', { text: 'Карточек нет' })));
}

export async function renderCardHealth(avatar, { inSheet = false } = {}) {
    const view = ui.$('#view');
    const { h, put, $, fmt } = ui;
    let data;
    try {
        data = await ui.api(`/card-health?avatar=${encodeURIComponent(avatar)}`);
    } catch (error) {
        return h('div', { class: 'empty' }, h('h2', { text: 'Не удалось оценить карточку' }), h('p', { text: error.message }));
    }
    const related = ui.state.proposals.filter(p => data.open.includes(p.id));
    const body = h('div', {},
        inSheet ? null : back('#tools/cards', 'Здоровье карточек'),
        h('div', { class: 'with-mascot' },
            mascot(data.score >= 80 ? 'done' : data.score >= 50 ? 'write' : 'confused', 88),
            h('div', {}, h('h2', { class: 'sheet-title', style: 'margin:0', text: data.name }),
                h('div', {}, h('span', { class: 'big', text: String(data.score) }), h('span', { class: 'secondary', text: ` из 100 · ${data.verdict}` })),
                h('p', { class: 'small muted', style: 'margin:0', text: `≈${fmt(data.tokens)} токенов в каждом запросе` }))),
        data.tips.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Что поправить' }),
            h('ul', { class: 'tips' }, data.tips.map(t => h('li', { class: t.level, text: t.text }))))
            : h('p', { class: 'secondary', text: 'Замечаний нет' }),
        related.length ? h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'Замечания Корректора' }), h('div', { class: 'list' }, related.map(ui.renderCard))) : null);
    if (!inSheet) put(view, body);
    return body;
}

// ---------- full backup ----------

export async function renderBackup() {
    const { h, put, $, fmt, plural } = ui;
    const view = $('#view');
    put(view, back('#tools', 'Ещё'), h('p', { class: 'muted', text: 'Считаю файлы' }));
    let info = null;
    let safety = [];
    try {
        [info, safety] = await Promise.all([ui.api('/archive/info'), ui.api('/archive/safety').then(r => r.items)]);
    } catch (error) {
        put(view, back('#tools', 'Ещё'), h('div', { class: 'empty' }, h('h2', { text: 'Не удалось открыть' }), h('p', { text: error.message })));
        return;
    }
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
    fileInput.addEventListener('change', () => fileInput.files[0] && upload(fileInput.files[0]));

    async function upload(file) {
        status.textContent = 'Загружаю и проверяю архив…';
        try {
            const token = await ui.csrfToken();
            const res = await fetch(`${ui.BASE}/archive/upload`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip', 'X-CSRF-Token': token, 'X-Korrektor': '1' }, body: file });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
            if (!data.looksLikeSillyTavern) throw new Error('В архиве нет чатов, карточек или настроек SillyTavern');
            const folders = Object.entries(data.folders).map(([k, v]) => `${k}: ${v}`).join(', ');
            const ok = await ui.confirmDialog({
                title: 'Восстановить из копии?',
                text: `В архиве ${data.files} ${plural(data.files, 'файл', 'файла', 'файлов')} (${bytes(data.bytes)}): ${folders}. Файлы с теми же именами заменятся, остальные останутся. Перед этим Корректор сохранит копию текущего состояния. Ключи API не затрагиваются`,
                ok: 'Восстановить', danger: true,
            });
            if (!ok) {
                status.textContent = '';
                return;
            }
            status.textContent = 'Сохраняю текущее состояние и восстанавливаю…';
            const result = await ui.api('/archive/restore', { method: 'POST', body: { upload: data.upload }, timeout: 600000 });
            ui.toast(`Восстановлено файлов: ${result.restored}. Вкладка SillyTavern обновится`);
            renderBackup();
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
        } finally {
            fileInput.value = '';
        }
    }

    put(view,
        back('#tools', 'Ещё'),
        h('div', { class: 'section' },
            mascotRow('books', 'Копия всех данных', `${fmt(info.files)} ${plural(info.files, 'файл', 'файла', 'файлов')}, ≈${bytes(info.bytes)}. Чаты, карточки, лорбуки, пресеты и настройки. Ключи API (secrets.json) в копию не попадают`),
            h('div', { class: 'card-actions' },
                h('a', { class: 'btn primary', href: `${ui.BASE}/archive`, download: '', onclick: () => ui.toast(inApp() ? 'Сохраняю в Загрузки/Korrektor' : 'Скачивание началось') , text: 'Скачать копию' })),
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Сохраните файл в облако или на компьютер: так данные переживут даже переустановку Termux' })),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Восстановить' }),
            h('p', { class: 'small secondary', style: 'margin:0', text: 'Выберите ZIP, скачанный здесь раньше. Перед восстановлением сохранится копия текущего состояния' }),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => fileInput.click(), text: 'Выбрать файл' })),
            fileInput, status),
        safety.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Копии перед восстановлением' }),
            h('div', { class: 'rows' }, safety.map(s => h('a', { class: 'row row-link', href: `${ui.BASE}/archive/safety/${encodeURIComponent(s.name)}`, download: '' },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: s.name.replace(/^before-restore-|\.zip$/g, '') })),
                h('span', { class: 'row-side', text: bytes(s.bytes) }))))) : null);
}

// ---------- import by link ----------

export async function importFromUrl() {
    throw new Error('Импорт по ссылке временно отключён');
}

export function renderImport(prefill = '') {
    const { h, put, $ } = ui;
    const input = h('input', { class: 'input', type: 'url', placeholder: 'https://chub.ai/characters/…', 'aria-label': 'Ссылка', value: prefill, autocapitalize: 'off', spellcheck: 'false' });
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const button = h('button', { class: 'btn primary', type: 'button', text: 'Импортировать' });
    const go = async () => {
        button.disabled = true;
        try {
            const result = await importFromUrl(input.value, status);
            status.textContent = '';
            put(result_box, mascotRow('done', result.type === 'lorebook' ? 'Лорбук добавлен' : 'Персонаж добавлен', `«${result.name}» уже в SillyTavern${result.type === 'lorebook' ? ', в списке лорбуков' : ', в списке персонажей'}`));
            input.value = '';
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
        } finally {
            button.disabled = false;
        }
    };
    button.addEventListener('click', go);
    const result_box = h('div', {});
    put($('#view'),
        back('#tools', 'Ещё'),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Ссылка на карточку или лорбук' }),
            h('div', { class: 'field-row' }, input),
            h('div', { class: 'card-actions' }, button),
            status,
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Скачивает сам SillyTavern, поэтому подходят те же сайты, что в его импорте: Chub, JanitorAI, RisuRealm, Pygmalion, AICharacterCards и прямые ссылки на PNG или JSON. В приложении можно просто «Поделиться» ссылкой с Корректором' })),
        result_box);
    if (prefill) go();
}

async function renderExtensions(container) {
    const { h, put } = ui;
    put(container, h('p', { class: 'muted', text: 'Проверяю установленные расширения' }));
    try {
        const result = await ui.api('/extensions/review', { timeout: 60000 });
        if (!container.isConnected) return;
        put(container,
            h('p', { class: 'small muted', text: 'Локальная проверка отмечает выполнение кода из строк, системные команды и загрузку кода с других сайтов. Такие находки требуют просмотра. Проверка не гарантирует отсутствие вредоносного кода' }),
            result.items.length ? result.items.map(item => h('article', { class: 'card' },
                h('h2', { class: 'card-title', text: item.name }),
                h('p', { class: 'small', text: `${item.files} файлов проверено${item.complete ? '' : ' · проверка неполная'}` }),
                item.findings.length ? h('ul', {}, item.findings.map(finding => h('li', { text: `${finding.label} — ${finding.file}, строка ${finding.line}` })))
                    : h('p', { class: 'muted', text: 'Совпадений с правилами проверки не найдено' })))
                : h('p', { text: 'Сторонние расширения пока не установлены' }),
            h('button', { class: 'btn secondary', type: 'button', text: 'Проверить снова', onclick: () => renderExtensions(container) }));
    } catch (error) { if (container.isConnected) put(container, h('p', { text: error.message }), h('button', { class: 'btn secondary', type: 'button', text: 'Повторить проверку', onclick: () => renderExtensions(container) })); }
}

// ---------- catalog ----------

// ---------- catalog ----------

const CATALOG_NAMES = { preset: 'Пресет', lorebook: 'Лорбук', card: 'Карточка', extension: 'Расширение' };
const CATALOG_TYPES = [['preset', 'Пресет'], ['lorebook', 'Лорбук'], ['card', 'Карточка']];
// Loaded once per visit: switching between presets, lorebooks and cards only filters it.
let catalogData = null;
let catalogAt = 0;
let catalogInstalledCache = null;
let catalogInstalledAt = 0;
const catalogFilters = { author: '', model: '', censor: '', language: '', translation: '', text: '' };
const SEEN_CATALOG_KEY = 'korrektor.seenCatalogIds';

function readSeenCatalogIds() {
    try {
        const raw = ui.storageGet(SEEN_CATALOG_KEY);
        const list = raw ? JSON.parse(raw) : null;
        return Array.isArray(list) ? new Set(list.map(String)) : null;
    } catch {
        return null;
    }
}

export function markCatalogSeen(items) {
    if (!Array.isArray(items) || !items.length) return;
    const seen = readSeenCatalogIds() || new Set();
    for (const item of items) {
        const id = typeof item === 'string' ? item : item?.id;
        if (id) seen.add(String(id));
    }
    ui.storageSet(SEEN_CATALOG_KEY, JSON.stringify([...seen]));
    setCatalogBadge(0);
}

function setCatalogBadge(count) {
    const n = Math.max(0, Number(count) || 0);
    const el = document.getElementById('catalog-count');
    if (el) el.textContent = n ? `+${n}` : '';
    try {
        window.KorrektorFiles?.catalogBadge?.(n);
    } catch {
        // outside Android bridge
    }
}

export async function checkCatalogNew() {
    try {
        const head = await ui.api('/catalog/head');
        const ids = Array.isArray(head?.ids) ? head.ids.map(String) : [];
        if (!ids.length) return 0;
        const seen = readSeenCatalogIds();
        if (!seen) {
            ui.storageSet(SEEN_CATALOG_KEY, JSON.stringify(ids));
            setCatalogBadge(0);
            return 0;
        }
        const fresh = ids.filter(id => !seen.has(id));
        if (location.hash === '#tools/catalog') {
            markCatalogSeen(ids);
            return 0;
        }
        setCatalogBadge(fresh.length);
        return fresh.length;
    } catch {
        return 0;
    }
}

async function loadCatalogData(force = false) {
    if (!force && catalogData && Date.now() - catalogAt < 5 * 60000) return catalogData;
    try {
        catalogData = await ui.api(`/catalog${force ? '?force=1' : ''}`);
    } catch (error) {
        catalogData = { items: catalogData?.items || [], submit: catalogData?.submit || '', error: error.message };
    }
    catalogAt = Date.now();
    return catalogData;
}

/** Segmented switch that changes in place, without redrawing the screen. */
function pick(options, value, onchange) {
    const { h } = ui;
    const box = h('div', { class: 'seg', role: 'group' });
    options.forEach(([v, label]) => box.append(h('button', {
        type: 'button', 'aria-pressed': String(value === v), onclick: (e) => {
            for (const b of box.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            onchange(v);
        },
    }, label)));
    return box;
}

const CATALOG_MODELS = ['Claude', 'GPT', 'Gemini', 'DeepSeek', 'GLM', 'Grok', 'Kimi', 'Qwen', 'Mistral', 'Llama'];

/** Pictures of a record: its own, and for a card the card itself first. */
function picturesOf(item) {
    return [...(item.type === 'card' ? [item.url] : []), ...(item.images || [])];
}

/** Full-screen pictures: swipe or arrows, tap outside to close. */
function openViewer(urls, start = 0) {
    const { h } = ui;
    let index = start;
    const img = h('img', { class: 'viewer-img', alt: '', decoding: 'async' });
    const counter = h('span', { class: 'viewer-count' });
    const show = () => {
        img.src = urls[index];
        counter.textContent = urls.length > 1 ? `${index + 1} / ${urls.length}` : '';
    };
    const step = (d) => { index = (index + d + urls.length) % urls.length; show(); };
    const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); };
    const root = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Картинки', onclick: (e) => { if (e.target === root) close(); } },
        img,
        urls.length > 1 ? h('button', { class: 'viewer-nav prev', type: 'button', 'aria-label': 'Назад', onclick: () => step(-1), text: '‹' }) : null,
        urls.length > 1 ? h('button', { class: 'viewer-nav next', type: 'button', 'aria-label': 'Дальше', onclick: () => step(1), text: '›' }) : null,
        h('button', { class: 'viewer-close', type: 'button', 'aria-label': 'Закрыть', onclick: close, text: '✕' }),
        counter);
    let startX = null;
    img.addEventListener('pointerdown', (e) => { startX = e.clientX; });
    img.addEventListener('pointerup', (e) => {
        if (startX === null) return;
        const dx = e.clientX - startX;
        startX = null;
        if (Math.abs(dx) > 40 && urls.length > 1) step(dx < 0 ? 1 : -1);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(root);
    show();
}

function catalogEntry(item, extra) {
    const { h } = ui;
    const pictures = picturesOf(item);
    const badges = [
        item.uncensored === true ? h('span', { class: 'badge uncensored', text: 'Без цензуры' }) : null,
        item.uncensored === false ? h('span', { class: 'badge', text: 'С цензурой' }) : null,
        ...item.models.map(m => h('span', { class: 'badge model', text: m })),
        item.regex ? h('span', { class: 'badge', text: `+ регексы: ${item.regex}` }) : null,
        item.language ? h('span', { class: 'badge', text: CATALOG_LANGUAGES.find(([code]) => code === item.language)?.[1] || item.language }) : null,
        typeof item.translated === 'boolean' ? h('span', { class: 'badge', text: item.translated ? 'С переводом' : 'Без перевода' }) : null,
    ].filter(Boolean);
    return h('article', { class: 'card catalog-item' },
        pictures.length ? h('button', { class: 'catalog-thumb-button', type: 'button', 'aria-label': 'Смотреть картинки', onclick: () => openViewer(pictures) },
            h('img', { class: 'catalog-thumb', src: pictures[0], alt: '', loading: 'lazy', decoding: 'async', width: 72, height: 96 }),
            pictures.length > 1 ? h('span', { class: 'thumb-count', text: `${pictures.length}` }) : null) : null,
        h('div', { class: 'catalog-body' },
            h('div', { class: 'card-meta' }, h('span', { class: 'status-tag', text: CATALOG_NAMES[item.type] }), item.author ? h('span', { class: 'meta', text: item.author }) : null),
            h('h2', { class: 'card-title', text: item.name }),
            item.description ? h('p', { class: 'card-summary', text: item.description }) : null,
            badges.length ? h('div', { class: 'badges' }, badges) : null,
            item.tags.length ? h('p', { class: 'small muted', style: 'margin:0', text: item.tags.join(' · ') }) : null,
            h('div', { class: 'card-actions' }, extra)));
}

export async function renderCatalog() {
    const { h, put, $ } = ui;
    const view = $('#view');
    let filter = ui.storageGet('korrektor.catalogFilter') || 'all';
    const needsLoad = !catalogData || Date.now() - catalogAt >= 5 * 60000;
    const data = catalogData || { items: [] };
    if (location.hash !== '#tools/catalog') return;

    // What is already in this tavern: { [id]: { file, where } }. Cached for a minute so tab switches are instant.
    let installed = catalogInstalledCache && Date.now() - catalogInstalledAt < 60000 ? catalogInstalledCache : null;
    if (data.items.length) markCatalogSeen(data.items);
    const install = async (item, button) => {
        const ok = await ui.confirmDialog({ title: `Установить «${item.name}»?`, text: item.type === 'extension' ? `Расширение от ${item.author || 'автора'} выполняет код в SillyTavern. Устанавливайте его, если доверяете источнику. После установки обновите страницу таверны` : `${CATALOG_NAMES[item.type]} от ${item.author || 'автора'} скачается в SillyTavern. Ваши файлы не перезаписываются: если имя занято, у нового будет номер`, ok: 'Установить' });
        if (!ok) return;
        button.disabled = true;
        button.textContent = 'Устанавливаю…';
        try {
            const result = await ui.api('/catalog/install', { method: 'POST', body: { id: item.id }, timeout: 120000 });
            ui.toast(`Установлено: ${result.where} → ${result.name}${result.reload ? '. Обновите страницу таверны, чтобы включить расширение' : ''}`);
            installed = { ...(installed || {}), [item.id]: { file: result.file, where: result.where } };
            catalogInstalledCache = installed;
            catalogInstalledAt = Date.now();
            drawList();
        } catch (error) {
            ui.toast(error.message, true);
            button.disabled = false;
            button.textContent = 'Установить';
        }
    };
    const uninstall = async (item, button) => {
        const where = installed?.[item.id];
        const ok = await ui.confirmDialog({
            title: `Удалить «${item.name}» из таверны?`,
            text: `Файл «${where?.file || item.name}» уйдёт из раздела «${where?.where || CATALOG_NAMES[item.type]}». Его копия останется в резервных копиях Корректора (korrektor/backups/catalog)${item.type === 'card' ? '. Чаты с персонажем не удаляются' : ''}`,
            ok: 'Удалить', danger: true,
        });
        if (!ok) return;
        button.disabled = true;
        try {
            const result = await ui.api('/catalog/uninstall', { method: 'POST', body: { id: item.id }, timeout: 60000 });
            ui.toast(`Удалено из таверны: ${item.name}${result.reload ? '. Обновите страницу таверны' : ''}`);
            installed = { ...(installed || {}) };
            delete installed[item.id];
            catalogInstalledCache = installed;
            catalogInstalledAt = Date.now();
            drawList();
        } catch (error) {
            ui.toast(error.message, true);
            button.disabled = false;
        }
    };
    const actionsFor = (item) => {
        const page = item.page ? h('a', { class: 'btn secondary small', href: item.page, target: '_blank', rel: 'noopener', text: 'Страница автора' }) : null;
        if (!installed) return [h('button', { class: 'btn secondary small', type: 'button', disabled: true, text: 'Проверяю…' }), page];
        if (installed[item.id]) {
            const remove = h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить' });
            remove.addEventListener('click', () => uninstall(item, remove));
            return [h('button', { class: 'btn secondary small installed', type: 'button', disabled: true, text: '✓ Установлено' }), remove, page];
        }
        const button = h('button', { class: 'btn primary small', type: 'button', text: 'Установить' });
        button.addEventListener('click', () => install(item, button));
        return [button, page];
    };
    // Search and filters: by author, by AI model, by censorship. Applied in place.
    const pickFilter = catalogFilters;
    const authors = [...new Set(data.items.map(i => i.author).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const models = [...new Set(data.items.flatMap(i => i.models))].sort((a, b) => a.localeCompare(b));
    const select = (label, options, key) => {
        const field = h('select', { class: 'select', 'aria-label': label, onchange: (e) => { pickFilter[key] = e.target.value; drawList(); } },
            h('option', { value: '', text: label }), options.map(([v, t]) => h('option', { value: v, text: t })));
        field.value = pickFilter[key];
        return field;
    };
    const search = h('input', { class: 'input', type: 'search', value: pickFilter.text, placeholder: 'Поиск по названию, описанию, тегам', 'aria-label': 'Поиск', oninput: () => { pickFilter.text = search.value.trim().toLowerCase(); drawList(); } });
    const filterBar = h('div', { class: 'catalog-filters' },
        search,
        h('div', { class: 'catalog-selects' },
            authors.length > 1 ? select('Все авторы', authors.map(a => [a, a]), 'author') : null,
            models.length ? select('Все модели', models.map(m => [m, m]), 'model') : null,
            select('Все языки', CATALOG_LANGUAGES, 'language'),
            select('Перевод: любой', [['yes', 'С переводом'], ['no', 'Без перевода']], 'translation'),
            select('Цензура: любая', [['no', 'Без цензуры'], ['yes', 'С цензурой']], 'censor')));
    const matches = (item) => matchesCatalogFilters(item, { ...pickFilter, type: filter });
    const list = h('div', { class: 'list catalog-list' });
    const drawList = () => {
        if (!catalogData) { put(list, h('p', { class: 'muted', text: 'Загружаю каталог' })); return; }
        const items = data.items.filter(matches);
        put(list, items.length ? items.map(item => catalogEntry(item, actionsFor(item))) : h('div', { class: 'empty' }, mascot('books', 150),
            h('h2', { text: data.items.length ? 'Ничего не нашлось' : 'Каталог пока пуст' }),
            h('p', { text: 'Здесь появятся пресеты, лорбуки, карточки и расширения, которые авторы разрешили распространять' })));
    };
    const filters = h('div', { class: 'filters' }, [['all', 'Все'], ['preset', 'Пресеты'], ['lorebook', 'Лорбуки'], ['card', 'Карточки'], ['extension', 'Расширения']].map(([v, text]) =>
        h('button', {
            class: 'filter', type: 'button', 'aria-pressed': String(filter === v), onclick: (e) => {
                if (filter === v) return;
                filter = v;
                ui.storageSet('korrektor.catalogFilter', v);
                for (const b of filters.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
                drawList();
            },
        }, text)));
    drawList();
    put(view,
        inApp() ? null : back('#tools', 'Ещё'),
        filters,
        filterBar,
        data.error ? h('p', { class: 'small', style: 'color:var(--del-text)', text: data.error }) : null,
        list,
        h('div', { class: 'section' },
            h('div', { class: 'card-actions centered', style: 'margin-top:0' },
                h('a', { class: 'btn secondary', href: '#tools/catalog-suggest', text: 'Предложить своё' }),
                h('button', { class: 'btn quiet', type: 'button', text: 'Обновить список', onclick: async () => { catalogInstalledCache = null; await loadCatalogData(true); if (view.isConnected) renderCatalog(); } }))));
    authorEntrance();
    if (needsLoad) {
        loadCatalogData().then((loaded) => {
            if (loaded?.items?.length) markCatalogSeen(loaded.items);
            if (view.isConnected && location.hash === '#tools/catalog') renderCatalog();
        });
    }
    if (data.items.length && !installed) {
        ui.api('/catalog/status', { timeout: 120000 }).then((r) => {
            installed = r.installed || {};
            catalogInstalledCache = installed;
            catalogInstalledAt = Date.now();
        }, () => { installed = {}; })
            .then(() => { if (list.isConnected) drawList(); });
    }
}

/** The author's page opens with a long press on the «Каталог» title: other people do not need it. */
function authorEntrance() {
    const title = ui.$('#page-title');
    if (!title || title.dataset.catalogPress) return;
    title.dataset.catalogPress = '1';
    let timer = null;
    const cancel = () => { clearTimeout(timer); timer = null; };
    title.addEventListener('pointerdown', () => {
        if (location.hash !== '#tools/catalog') return;
        cancel();
        timer = setTimeout(() => {
            timer = null;
            navigator.vibrate?.(20);
            location.hash = '#tools/catalog-author';
        }, 700);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) title.addEventListener(type, cancel);
    title.addEventListener('contextmenu', (e) => { if (location.hash === '#tools/catalog') e.preventDefault(); });
}

function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    } catch {
        // fall back below
    }
    return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    area.remove();
    return ok;
}

/** A picker of this tavern's presets, lorebooks or cards. Calls onchange(file, name). */
function localPicker(type, onchange) {
    const { h } = ui;
    const select = h('select', { class: 'select', style: 'width:100%', 'aria-label': 'Файл из таверны' }, h('option', { value: '', text: 'Загружаю список…' }));
    select.disabled = true;
    ui.api(`/catalog/local?type=${type}`).then(({ items }) => {
        select.replaceChildren(h('option', { value: '', text: items.length ? 'Выберите…' : 'В таверне таких файлов нет' }),
            ...items.map(i => h('option', { value: i.file, text: i.name })));
        select._rows = items;
        select.disabled = !items.length;
    }).catch((error) => {
        select.replaceChildren(h('option', { value: '', text: error.message }));
    });
    select.addEventListener('change', () => onchange(select.value, select.selectedOptions[0]?.textContent || '', (select._rows || []).find(r => r.file === select.value)));
    return select;
}

// People send their presets and lorebooks to the catalog's author.
export async function renderCatalogSuggest() {
    const { h, put, $ } = ui;
    const view = $('#view');
    const data = await loadCatalogData();
    if (location.hash !== '#tools/catalog-suggest') return;
    let type = 'preset';
    let file = '';
    let fileName = '';
    // Global regexes that go into the preset: the enabled ones, unless removed here.
    let regexes = [];
    const pickerBox = h('div', { style: 'margin-top:12px' });
    const regexBox = h('div');
    const template = h('textarea', { class: 'input', rows: 6, style: 'width:100%;height:auto;padding:10px 12px;resize:vertical' });
    const fillTemplate = (name = '') => {
        template.value = `Хочу предложить в каталог Корректора\nТип: ${CATALOG_NAMES[type].toLowerCase()}\nНазвание: ${name}\nАвтор: \nЧто это (пара предложений): \nАвтор разрешил распространять: да`;
    };
    const drawRegex = (inside = []) => {
        if (type !== 'preset' || !file) return put(regexBox);
        put(regexBox, h('div', { class: 'regex-box' },
            h('h3', { class: 'section-title', style: 'margin-top:12px', text: 'Регексы с пресетом' }),
            inside.length ? h('p', { class: 'small muted', style: 'margin:0 0 6px', text: `Уже внутри пресета: ${inside.join(', ')}` }) : null,
            regexes.length ? h('div', { class: 'badges' }, regexes.map((r, i) => h('button', { class: 'badge removable', type: 'button', title: 'Не прикладывать', onclick: () => { regexes.splice(i, 1); drawRegex(inside); }, text: `${r.name} ✕` }))) : null,
            h('p', { class: 'small muted', style: 'margin:6px 0 0', text: regexes.length ? 'Включённые регексы вашей таверны вложатся в файл пресета. Лишний — нажмите на него' : inside.length ? '' : 'Включённых регексов в таверне нет' })));
    };
    const drawPicker = () => {
        file = '';
        fileName = '';
        regexes = [];
        drawRegex();
        put(pickerBox, localPicker(type, async (value, name, row) => {
            file = value;
            fileName = name;
            fillTemplate(value ? name : '');
            if (type === 'preset' && value) {
                try {
                    regexes = (await ui.api('/catalog/regex')).global.filter(g => !g.disabled);
                } catch {
                    regexes = [];
                }
            }
            drawRegex(row?.regexNames || []);
        }));
        fillTemplate();
    };
    const exportUrl = () => `${ui.BASE}/catalog/export?type=${type}&file=${encodeURIComponent(file)}${type === 'preset' && regexes.length ? `&regex=${encodeURIComponent(regexes.map(r => r.id).join(','))}` : ''}`;
    const link = data.submit;
    const send = async (e) => {
        if (!file) return ui.toast('Сначала выберите файл', true);
        const button = e.currentTarget;
        button.disabled = true;
        try {
            const res = await fetch(exportUrl(), { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`Ошибка ${res.status}`);
            const blob = await res.blob();
            const name = file;
            const mime = type === 'card' ? 'image/png' : 'application/json';
            const text = `${template.value}${link ? `\n\n${link}` : ''}`;
            if (window.KorrektorFiles?.share) {
                // In the app: Android's «Share» with the file attached; pick Telegram and the author's chat.
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                window.KorrektorFiles.share(name, mime, base64, template.value);
            } else if (navigator.canShare?.({ files: [new File([blob], name, { type: mime })] })) {
                await navigator.share({ files: [new File([blob], name, { type: mime })], text: template.value });
            } else {
                // A computer: the file is saved, the chat opens; attach the file there.
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
                await copyText(text);
                if (link) window.open(link, '_blank', 'noopener');
                ui.toast('Файл сохранён, текст скопирован: прикрепите файл в чате автора');
            }
        } catch (error) {
            if (error.name !== 'AbortError') ui.toast(error.message, true);
        } finally {
            button.disabled = false;
        }
    };
    drawPicker();
    put(view,
        back('#tools/catalog', 'Каталог'),
        h('div', { class: 'section' },
            mascotRow('books', 'Поделиться своим', 'Выберите файл из своей таверны и нажмите «Отправить»: откроется «Поделиться» с уже прикреплённым файлом — выберите Telegram и чат автора каталога. Чужое — только с разрешения автора')),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Что отправить' }),
            pick(CATALOG_TYPES, type, (v) => { type = v; drawPicker(); }),
            pickerBox,
            regexBox,
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Из пресета перед отправкой убираются пароли, адреса прокси и всё похожее на ключи' })),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Сообщение к файлу' }),
            template,
            h('div', { class: 'card-actions centered' },
                h('button', { class: 'btn primary', type: 'button', text: 'Отправить', onclick: send }),
                link ? h('a', { class: 'btn secondary', href: link, target: '_blank', rel: 'noopener', text: 'Чат автора' }) : null),
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: link ? `Чат автора каталога: ${link.replace(/^https:\/\//, '')}. Если его нет в списке «Поделиться», откройте его кнопкой «Чат автора» и напишите что-нибудь — потом он появится` : 'Отправьте файл в Telegram-канал Корректора' })));
}

// ---------- a file shared to the app (from Telegram) ----------

let incoming = null;

/** A file shared to the app: recognised, checked by the plugin, then shown on its own screen. */
export async function receiveFile(name, base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob = new Blob([bytes]);
    let type = '';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) type = 'card';
    else if (bytes[0] === 0x50 && bytes[1] === 0x4b) type = 'extension';
    else {
        try {
            const json = JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ''));
            const first = Array.isArray(json) ? json[0] : json;
            type = typeof first?.findRegex === 'string' ? 'regex' : json && typeof json.entries === 'object' && !json.prompts ? 'lorebook' : 'preset';
        } catch {
            type = '';
        }
    }
    try {
        if (!type) throw new Error('Это не пресет, не лорбук, не карточка, не расширение (ZIP) и не регекс SillyTavern');
        if (type === 'regex') {
            const r = await uploadRaw('/catalog/upload-regex', blob);
            incoming = { type, name, upload: r.upload, regexNames: r.names };
        } else {
            const r = await uploadRaw(`/catalog/upload?type=${type}&name=${encodeURIComponent(name)}`, blob);
            incoming = { type, name, upload: r.upload, title: r.title, removed: r.removed || [], regexNames: r.regexNames || [] };
        }
        if (location.hash === '#tools/incoming') renderIncoming();
        else location.hash = '#tools/incoming';
    } catch (error) {
        ui.toast(`${name}: ${error.message}`, true);
    }
}

export async function renderIncoming() {
    const { h, put, $ } = ui;
    const view = $('#view');
    if (!incoming) {
        put(view, back('#tools', 'Ещё'), h('div', { class: 'empty' }, mascot('confused', 150), h('h2', { text: 'Файла нет' }), h('p', { text: 'Поделитесь файлом пресета, лорбука или карточки с Корректором — например из Telegram' })));
        return;
    }
    const file = incoming;
    let admin = { hasToken: false };
    try {
        admin = await ui.api('/catalog/admin');
    } catch {
        // without the author's page the file can still be installed
    }
    const install = async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
            const r = await ui.api('/catalog/install-upload', { method: 'POST', body: { type: file.type, upload: file.upload, name: file.title || file.name.replace(/\.[^.]+$/, '') } });
            ui.toast(`Установлено: ${r.where} → ${r.name}`);
            button.textContent = '✓ Установлено';
        } catch (error) {
            ui.toast(error.message, true);
            button.disabled = false;
        }
    };
    const what = file.type === 'regex' ? 'Регекс' : CATALOG_NAMES[file.type];
    put(view,
        back('#tools', 'Ещё'),
        h('div', { class: 'section' },
            mascotRow(file.type === 'regex' ? 'key' : 'books', `${what}: ${file.title || file.name}`, `Файл «${file.name}» получен.${file.regexNames?.length ? ` Регексы${file.type === 'preset' ? ' внутри' : ''}: ${file.regexNames.join(', ')}.` : ''}${file.removed?.length ? ` Из пресета убрано: ${file.removed.join(', ')}.` : ''}`)),
        h('div', { class: 'card-actions centered' },
            file.type !== 'regex' ? h('button', { class: 'btn primary', type: 'button', text: 'Установить в таверну', onclick: install }) : null,
            admin.hasToken ? h('a', { class: 'btn secondary', href: '#tools/catalog-author', text: file.type === 'regex' ? 'Приложить к пресету в каталоге' : 'Опубликовать в каталог' }) : null),
        file.type === 'regex' && !admin.hasToken ? h('p', { class: 'small muted', style: 'text-align:center', text: 'Регекс ставится в самой таверне: Расширения → Regex → Импорт' }) : null);
}

/** For the author's page: the shared file, once. */
export function takeIncoming() {
    const file = incoming;
    incoming = null;
    return file;
}

// For the catalog's author: publishing to GitHub.
export async function renderCatalogAuthor() {
    const { h, put, $ } = ui;
    const view = $('#view');
    let admin;
    try {
        admin = await ui.api('/catalog/admin');
    } catch (error) {
        put(view, back('#tools/catalog', 'Каталог'), h('div', { class: 'empty' }, h('h2', { text: 'Не удалось открыть' }), h('p', { text: error.message })));
        return;
    }
    if (location.hash !== '#tools/catalog-author') return;

    if (!admin.hasToken) {
        const token = h('input', { class: 'input mono', style: 'width:100%', type: 'password', placeholder: 'github_pat_…', 'aria-label': 'Токен GitHub', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
        const saveToken = async (e) => {
            e.currentTarget.disabled = true;
            try {
                const r = await ui.api('/catalog/admin', { method: 'POST', body: { token: token.value.trim() } });
                ui.toast(r.login ? `Токен подходит: ${r.login}` : 'Токен подходит');
                renderCatalogAuthor();
            } catch (error) {
                ui.toast(error.message, true);
                e.currentTarget.disabled = false;
            }
        };
        put(view,
            back('#tools/catalog', 'Каталог'),
            h('div', { class: 'section' },
                mascotRow('key', 'Каталог ведёте вы', 'Отсюда пресеты, лорбуки и карточки попадают в каталог для всех: Корректор кладёт файл в репозиторий на GitHub и дописывает запись. Нужен токен GitHub, один раз')),
            h('div', { class: 'section' },
                h('h3', { class: 'section-title', text: 'Как получить токен' }),
                h('ol', { class: 'steps' },
                    h('li', { text: `Войдите на github.com в аккаунт, которому принадлежит репозиторий ${admin.repo}` }),
                    h('li', { text: 'Аватар → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token' }),
                    h('li', { text: `Repository access: Only select repositories → ${admin.repo.split('/')[1]}. Permissions → Contents: Read and write. Срок — какой удобно` }),
                    h('li', { text: 'Нажмите Generate token, скопируйте токен (начинается с github_pat_) и вставьте сюда' })),
                h('div', { class: 'field-row', style: 'margin-top:12px' }, token),
                h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', type: 'button', text: 'Сохранить токен', onclick: saveToken })),
                h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Токен хранится только в этой таверне: в резервные копии и синхронизацию не попадает, обратно в приложении не показывается. Пользователям этот раздел не нужен: у них нет токена' })));
        return;
    }

    const data = await loadCatalogData(true);
    if (location.hash !== '#tools/catalog-author') return;
    let type = 'preset';
    let source = 'local';
    let file = '';
    let upload = '';
    let sourceRevision = 0;
    const sourcePicker = h('div', { style: 'margin-top:8px' });
    const form = metaForm();
    const allowed = h('input', { type: 'checkbox' });
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const sourceBox = h('div', { style: 'margin-top:12px' });
    const regexBox = h('div', { class: 'regex-box' });
    const fileInput = h('input', { type: 'file', hidden: true });
    let regexUploads = [];
    let regexGlobal = new Set();
    // Regexes already inside the chosen preset, and the ones to drop from it.
    let inside = [];
    let drop = new Set();
    const shared = takeIncoming();
    const drawRegex = async () => {
        if (type !== 'preset') return put(regexBox);
        const regexInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
        regexInput.addEventListener('change', async () => {
            const f = regexInput.files[0];
            regexInput.value = '';
            if (!f) return;
            try {
                const r = await uploadRaw(`/catalog/upload-regex`, f);
                regexUploads.push({ upload: r.upload, names: r.names });
                drawRegex();
            } catch (error) {
                ui.toast(error.message, true);
            }
        });
        let globals = [];
        try {
            globals = (await ui.api('/catalog/regex')).global;
        } catch {
            globals = [];
        }
        if (type !== 'preset') return;
        put(regexBox,
            h('h3', { class: 'section-title', style: 'margin-top:16px', text: 'Регексы к пресету' }),
            inside.length ? h('div', {},
                h('p', { class: 'small muted', style: 'margin:0 0 6px', text: 'Уже внутри пресета (нажмите, чтобы убрать или вернуть):' }),
                h('div', { class: 'badges' }, inside.map((n, i) => h('button', {
                    class: `badge removable${drop.has(i) ? ' dropped' : ''}`, type: 'button',
                    onclick: () => { if (drop.has(i)) drop.delete(i); else drop.add(i); drawRegex(); },
                    text: drop.has(i) ? `${n} — убран` : `${n} ✕`,
                })))) : null,
            h('p', { class: 'small muted', style: 'margin:8px 0 8px', text: 'Регексы лежат внутри пресета: таверна сама предложит их включить, когда пресет выберут. Можно добавить общие регексы таверны или файл' }),
            globals.length ? h('div', { class: 'regex-list' }, globals.map(g => h('label', { class: 'check-row' },
                (() => { const box = h('input', { type: 'checkbox' }); box.checked = regexGlobal.has(g.id); box.addEventListener('change', () => { if (box.checked) regexGlobal.add(g.id); else regexGlobal.delete(g.id); }); return box; })(),
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: g.name }), g.disabled ? h('span', { class: 'row-sub', text: 'сейчас выключен' }) : null)))) : h('p', { class: 'small muted', style: 'margin:0', text: 'Общих регексов в таверне нет' }),
            regexUploads.length ? h('div', { class: 'badges', style: 'margin-top:8px' }, regexUploads.map((r, i) => h('button', { class: 'badge removable', type: 'button', title: 'Убрать', onclick: () => { regexUploads.splice(i, 1); drawRegex(); }, text: `${r.names.join(', ')} ✕` }))) : null,
            h('div', { class: 'card-actions', style: 'margin-top:8px' }, h('button', { class: 'btn secondary small', type: 'button', text: 'Добавить файл регекса', onclick: () => regexInput.click() }), regexInput));
    };
    const typePicker = h('div');
    const drawTypePicker = () => put(typePicker, pick([...CATALOG_TYPES, ['extension', 'Расширение']], type, (v) => { type = v; drawSource(); }));
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f) return;
        const isZip = /\.zip$/i.test(f.name || '') || /zip/i.test(f.type || '');
        if (isZip && type !== 'extension') {
            type = 'extension';
            source = 'upload';
            drawTypePicker();
            drawSource();
        }
        const revision = ++sourceRevision;
        const uploadType = type;
        status.textContent = 'Проверяю файл…';
        upload = '';
        try {
            const r = await uploadRaw(`/catalog/upload?type=${uploadType}&name=${encodeURIComponent(f.name)}`, f);
            if (revision !== sourceRevision) return;
            upload = r.upload;
            form.suggestName(r.title);
            inside = r.regexNames || [];
            drop = new Set();
            drawRegex();
            status.textContent = `Файл подходит: ${f.name}${r.removed?.length ? `. Из пресета убрано: ${r.removed.join(', ')}` : ''}`;
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
        } finally {
            fileInput.value = '';
        }
    });
    const drawSource = () => {
        sourceRevision++;
        if (type === 'extension' && source === 'local') source = 'upload';
        if (type !== 'extension' && source === 'repository') source = 'local';
        put(sourcePicker, pick(type === 'extension' ? [['upload', 'ZIP с телефона'], ['repository', 'Ссылка GitHub']] : [['local', 'Из таверны'], ['upload', 'Файл с телефона']], source, v => { source = v; drawSource(); }));
        file = '';
        upload = '';
        inside = [];
        drop = new Set();
        // Include .zip so choosing an extension archive works even before switching the type tab.
        fileInput.accept = type === 'extension' ? '.zip,application/zip,application/x-zip-compressed,application/octet-stream' : type === 'card' ? '.png,image/png,.zip,application/zip' : '.json,application/json,.zip,application/zip,application/x-zip-compressed';
        if (source === 'local') {
            put(sourceBox, localPicker(type, (value, label, row) => {
                file = value;
                if (value) form.suggestName(label);
                inside = row?.regexNames || [];
                drop = new Set();
                drawRegex();
            }));
        } else if (source === 'repository') {
            const url = h('input', { class: 'input', type: 'url', style: 'width:100%', 'aria-label': 'Репозиторий расширения', placeholder: 'https://github.com/автор/репозиторий', autocapitalize: 'off', spellcheck: 'false' });
            const load = h('button', { class: 'btn secondary', type: 'button', text: 'Загрузить с GitHub', onclick: async () => {
                const revision = ++sourceRevision;
                upload = '';
                load.disabled = true;
                status.textContent = 'Скачиваю и проверяю расширение…';
                try {
                    const result = await ui.api('/catalog/upload-repository', { method: 'POST', body: { url: url.value.trim() }, timeout: 90000 });
                    if (revision !== sourceRevision) return;
                    upload = result.upload;
                    form.suggestName(result.title);
                    form.suggestPage(result.page);
                    status.textContent = `Загружено: ${result.title}. Можно публиковать`;
                } catch (error) {
                    if (revision === sourceRevision) { status.textContent = error.message; }
                } finally { load.disabled = false; }
            } });
            put(sourceBox, url, h('div', { class: 'card-actions' }, load), h('p', { class: 'small muted', text: 'Публичный репозиторий. В каталог попадёт текущая версия из основной ветки; в ней нужен manifest.json' }));
        } else {
            put(sourceBox, type === 'extension' ? h('p', { class: 'small muted', text: 'ZIP до 20 МБ: manifest.json и файлы расширения в корне или в одной общей папке' }) : null, h('button', { class: 'btn secondary', type: 'button', text: type === 'extension' ? 'Выбрать ZIP-файл' : 'Выбрать файл', onclick: () => fileInput.click() }), fileInput);
        }
        status.textContent = '';
        drawRegex();
    };
    const publish = async (e) => {
        const button = e.currentTarget;
        if (source === 'local' ? !file : !upload) return ui.toast('Сначала выберите файл', true);
        if (form.busy()) return ui.toast('Подождите, картинки ещё загружаются', true);
        button.disabled = true;
        status.textContent = 'Отправляю на GitHub: файл, картинки и запись в каталоге. Большой лорбук на мобильном интернете — до минуты…';
        try {
            const r = await ui.api('/catalog/publish', {
                method: 'POST', timeout: 180000,
                body: {
                    type,
                    file: source === 'local' ? file : undefined,
                    upload: source !== 'local' ? upload : undefined,
                    meta: { ...form.values(), allowed: allowed.checked },
                    images: form.images().filter(i => i.upload).map(i => i.upload),
                    regex: type === 'preset' ? { global: [...regexGlobal], uploads: regexUploads.map(r => r.upload), drop: [...drop] } : undefined,
                },
            });
            ui.toast(`В каталоге: «${r.item.name}». У всех появится в течение нескольких минут`);
            catalogData = null;
            renderCatalogAuthor();
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
            button.disabled = false;
        }
    };
    const submit = h('input', { class: 'input', style: 'width:100%', type: 'text', inputmode: 'url', value: data.submit || '', placeholder: 't.me/ваш_ник или @ник', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const saveSubmit = async () => {
        try {
            const r = await ui.api('/catalog/submit-link', { method: 'POST', body: { link: submit.value.trim() } });
            submit.value = r.submit || '';
            catalogData = null;
            ui.toast(r.submit ? `Сохранено: ${r.submit}` : 'Ссылка убрана');
        } catch (error) {
            ui.toast(error.message, true);
        }
    };
    const remove = async (item, button) => {
        const ok = await ui.confirmDialog({ title: `Убрать «${item.name}»?`, text: 'Запись и её картинки исчезнут из каталога у всех. У тех, кто уже установил, файл останется', ok: 'Убрать', danger: true });
        if (!ok) return;
        button.disabled = true;
        try {
            await ui.api('/catalog/remove', { method: 'POST', body: { id: item.id }, timeout: 120000 });
            ui.toast('Убрано из каталога');
            catalogData = null;
            renderCatalogAuthor();
        } catch (error) {
            ui.toast(error.message, true);
            button.disabled = false;
        }
    };
    const forget = async () => {
        const ok = await ui.confirmDialog({ title: 'Удалить токен?', text: 'Публиковать отсюда будет нельзя, пока не добавите токен снова. Сам каталог не меняется', ok: 'Удалить', danger: true });
        if (!ok) return;
        await ui.api('/catalog/admin', { method: 'POST', body: { token: '' } });
        renderCatalogAuthor();
    };
    if (shared?.type === 'regex') {
        // A regex file shared from Telegram: it goes with the preset published next.
        regexUploads.push({ upload: shared.upload, names: shared.regexNames || [] });
    } else if (shared) {
        type = shared.type;
        source = 'upload';
    }
    drawTypePicker();
    drawSource();
    if (shared && shared.type !== 'regex') {
        upload = shared.upload;
        form.suggestName(shared.title || shared.name.replace(/\.[^.]+$/, ''));
        inside = shared.regexNames || [];
        put(sourceBox, h('p', { class: 'small secondary', style: 'margin:0', text: `Файл из Telegram: ${shared.name}` }));
        drawRegex();
        status.textContent = shared.removed?.length ? `Из пресета убрано: ${shared.removed.join(', ')}` : '';
    }
    put(view,
        back('#tools/catalog', 'Каталог'),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Добавить в каталог' }),
            typePicker,
            sourcePicker,
            sourceBox,
            regexBox,
            form.element,
            h('label', { class: 'check-row', style: 'margin-top:12px' }, allowed,
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Автор разрешил распространять' }), h('span', { class: 'row-sub', text: 'Без этого опубликовать нельзя' }))),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', type: 'button', text: 'Опубликовать', onclick: publish })),
            status,
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Из пресетов при публикации убираются пароли, адреса прокси и всё похожее на ключи' })),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Куда присылать предложения' }),
            h('div', { class: 'field-row' }, submit),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn secondary', type: 'button', text: 'Сохранить ссылку', onclick: saveSubmit })),
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Ваш Telegram: t.me/ник, @ник или ссылка на сообщения канала (t.me/канал?direct). По ней пользователи пришлют файлы с кнопки «Предложить своё»' })),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: `В каталоге сейчас: ${data.items.length}` }),
            data.items.length ? h('div', { class: 'list catalog-list' }, data.items.map(item => {
                const button = h('button', { class: 'btn quiet small', type: 'button', text: 'Убрать' });
                button.addEventListener('click', () => remove(item, button));
                return catalogEntry(item, [h('a', { class: 'btn secondary small', href: `#tools/catalog-edit/${encodeURIComponent(item.id)}`, text: 'Изменить' }), button]);
            })) : h('p', { class: 'small muted', text: 'Пока пусто' })),
        h('div', { class: 'section' },
            h('p', { class: 'small muted', style: 'margin:0', text: `Публикуется в ${admin.repo}${admin.login ? ` от имени ${admin.login}` : ''}` }),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить токен', onclick: forget }))));
}

/** Sends a file or a picture to the plugin as is (not JSON). */
async function uploadRaw(path, body) {
    const token = await ui.csrfToken();
    const res = await fetch(`${ui.BASE}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': token, 'X-Korrektor': '1' }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
}

/** A picture from the phone made small: at most `maxSide` pixels, WebP (JPEG if WebP cannot be made). */
async function compressImage(file, maxSide = 1280) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('Это не картинка'));
            i.src = url;
        });
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.82));
        if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (!blob) throw new Error('Не удалось уменьшить картинку');
        return blob;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Name, author, description, tags, AI models, censorship, page and pictures of a record:
 * the same form for publishing and for changing a published record.
 */
function metaForm(item = null) {
    const { h, put } = ui;
    const field = (label, input, hint) => h('label', { class: 'author-field' }, h('span', { class: 'small secondary', text: label }), input, hint ? h('span', { class: 'small muted', text: hint }) : null);
    const name = h('input', { class: 'input', style: 'width:100%', type: 'text', maxlength: 80, value: item?.name || '' });
    const author = h('input', { class: 'input', style: 'width:100%', type: 'text', maxlength: 60, value: item?.author || '' });
    const description = h('textarea', { class: 'input', rows: 3, maxlength: 400, style: 'width:100%;height:auto;padding:10px 12px;resize:vertical' });
    description.value = item?.description || '';
    const tags = h('input', { class: 'input', style: 'width:100%', type: 'text', placeholder: 'фэнтези, ромком', value: (item?.tags || []).join(', ') });
    const page = h('input', { class: 'input', style: 'width:100%', type: 'url', placeholder: 'https://… (необязательно)', autocapitalize: 'off', value: item?.page || '' });
    const language = h('select', { class: 'select', 'aria-label': 'Язык материала' }, h('option', { value: '', text: 'Не указан' }), CATALOG_LANGUAGES.map(([value, text]) => h('option', { value, text })));
    language.value = item?.language || '';
    const translation = h('select', { class: 'select', 'aria-label': 'Наличие перевода' }, [['', 'Не указано'], ['yes', 'С переводом'], ['no', 'Без перевода']].map(([value, text]) => h('option', { value, text })));
    translation.value = item?.translated === true ? 'yes' : item?.translated === false ? 'no' : '';
    const chosen = new Set(item?.models || []);
    const otherModels = h('input', { class: 'input', style: 'width:100%;margin-top:8px', type: 'text', placeholder: 'Другие модели через запятую', value: (item?.models || []).filter(m => !CATALOG_MODELS.includes(m)).join(', ') });
    const modelChips = h('div', { class: 'chips' }, CATALOG_MODELS.map(m => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(m)), onclick: (e) => {
            if (chosen.has(m)) chosen.delete(m); else chosen.add(m);
            e.currentTarget.setAttribute('aria-pressed', String(chosen.has(m)));
        },
    }, m)));
    let censor = item?.uncensored === true ? 'no' : item?.uncensored === false ? 'yes' : '';
    // Pictures: { keep: url } already published, { upload, preview } new from the phone.
    const pictures = (item?.images || []).map(url => ({ keep: url, preview: url }));
    let loading = 0;
    const picsBox = h('div', { class: 'pics' });
    const picInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const drawPics = () => {
        put(picsBox,
            pictures.map((p, i) => h('div', { class: 'pic' },
                h('img', { src: p.preview, alt: '', onclick: () => { if (i > 0) { pictures.unshift(...pictures.splice(i, 1)); drawPics(); } } }),
                i === 0 ? h('span', { class: 'pic-label', text: 'обложка' }) : null,
                h('button', { class: 'pic-x', type: 'button', 'aria-label': 'Убрать', onclick: () => { pictures.splice(i, 1); drawPics(); }, text: '✕' }))),
            loading ? h('div', { class: 'pic pic-add', text: 'Загружаю…' }) : null,
            pictures.length + loading < 4 ? h('button', { class: 'pic pic-add', type: 'button', onclick: () => picInput.click() }, h('b', { text: '+' }), h('span', { text: 'Картинка' })) : null,
            picInput);
    };
    picInput.addEventListener('change', async () => {
        const files = [...picInput.files].slice(0, 4 - pictures.length);
        picInput.value = '';
        for (const f of files) {
            loading++;
            drawPics();
            try {
                const blob = await compressImage(f, 1280);
                const r = await uploadRaw('/catalog/upload-image', blob);
                pictures.push({ upload: r.upload, preview: URL.createObjectURL(blob) });
            } catch (error) {
                ui.toast(error.message, true);
            } finally {
                loading--;
                drawPics();
            }
        }
    });
    drawPics();
    let autoName = item?.name || '';
    const element = h('div', { class: 'author-fields' },
        field('Название', name),
        field('Автор', author, 'Указывается в каталоге всегда'),
        field('Что это', description, 'Пара предложений: для чего и чем хорош'),
        field('Язык материала', language),
        field('Перевод', translation, 'Отметьте, есть ли перевод у этой версии материала'),
        h('div', { class: 'author-field' }, h('span', { class: 'small secondary', text: 'Картинки' }), picsBox,
            h('span', { class: 'small muted', text: 'До 4: первая — обложка, остальные — скриншоты. Нажмите на картинку, чтобы сделать её обложкой' })),
        h('div', { class: 'author-field' }, h('span', { class: 'small secondary', text: 'Для каких моделей' }), modelChips, otherModels),
        h('div', { class: 'author-field' }, h('span', { class: 'small secondary', text: 'Цензура' }),
            pick([['', 'Не указано'], ['no', 'Без цензуры'], ['yes', 'С цензурой']], censor, (v) => { censor = v; })),
        field('Теги', tags, 'Через запятую'),
        field('Страница автора', page));
    return {
        element,
        busy: () => loading > 0,
        suggestPage: (value) => { if (!page.value) page.value = value; },
        suggestName: (value) => {
            if (!name.value || name.value === autoName) name.value = value;
            autoName = value;
        },
        values: () => ({
            name: name.value,
            author: author.value,
            description: description.value,
            tags: tags.value,
            page: page.value,
            models: [...CATALOG_MODELS.filter(m => chosen.has(m)), ...otherModels.value.split(',').map(m => m.trim()).filter(Boolean)],
            uncensored: censor === 'no' ? true : censor === 'yes' ? false : undefined,
            language: language.value,
            translated: translation.value === 'yes' ? true : translation.value === 'no' ? false : null,
        }),
        images: () => pictures.map(p => (p.upload ? { upload: p.upload } : { keep: p.keep })),
    };
}

// Changing a published record: description, tags, models, censorship, pictures.
export async function renderCatalogEdit(id) {
    const { h, put, $ } = ui;
    const view = $('#view');
    const data = await loadCatalogData();
    const item = data.items.find(i => i.id === id);
    if (!item) {
        put(view, back('#tools/catalog-author', 'Ведение каталога'), h('div', { class: 'empty' }, h('h2', { text: 'Запись не найдена' })));
        return;
    }
    const form = metaForm(item);
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const save = async (e) => {
        const button = e.currentTarget;
        if (form.busy()) return ui.toast('Подождите, картинки ещё загружаются', true);
        button.disabled = true;
        status.textContent = 'Сохраняю на GitHub…';
        try {
            await ui.api('/catalog/edit', { method: 'POST', timeout: 180000, body: { id, meta: form.values(), images: form.images() } });
            ui.toast('Запись обновлена');
            catalogData = null;
            location.hash = '#tools/catalog-author';
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
            button.disabled = false;
        }
    };
    put(view,
        back('#tools/catalog-author', 'Ведение каталога'),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: `${CATALOG_NAMES[item.type]}: файл остаётся тем же` }),
            form.element,
            h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', type: 'button', text: 'Сохранить', onclick: save })),
            status));
}

// ---------- sync with the other device ----------

export async function renderSync() {
    const { h, put, $, plural } = ui;
    const view = $('#view');
    let info;
    try {
        info = await ui.api('/sync');
    } catch (error) {
        put(view, back('#tools', 'Ещё'), h('div', { class: 'empty' }, h('h2', { text: 'Не удалось открыть' }), h('p', { text: error.message })));
        return;
    }
    const peer = h('input', { class: 'input', style: 'width:100%', type: 'url', value: info.peer || '', placeholder: 'http://192.168.1.10:8000', 'aria-label': 'Адрес другой таверны', autocapitalize: 'off', spellcheck: 'false' });
    const login = h('input', { class: 'input', style: 'width:100%', type: 'text', value: info.login || '', placeholder: 'логин, если нужен', 'aria-label': 'Логин', autocapitalize: 'off', autocomplete: 'off' });
    const password = h('input', { class: 'input', style: 'width:100%', type: 'password', placeholder: info.hasPassword ? 'сохранён, впишите новый для замены' : 'пароль, если нужен', 'aria-label': 'Пароль', autocomplete: 'new-password' });
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const saveSettings = async (extra = {}) => {
        const body = { peer: peer.value.trim(), login: login.value.trim(), ...extra };
        if (password.value) body.password = password.value;
        await ui.api('/sync/settings', { method: 'POST', body });
        password.value = '';
    };
    const test = async () => {
        status.textContent = 'Проверяю связь…';
        try {
            await saveSettings();
            const r = await ui.api('/sync/test', { method: 'POST', timeout: 60000 });
            status.textContent = `Связь есть: «${r.device}», Корректор ${r.version}, файлов для синхронизации: ${r.files}`;
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
        }
    };
    const run = async () => {
        try {
            await saveSettings();
            status.textContent = 'Синхронизирую…';
            const job = await ui.api('/sync/run', { method: 'POST' });
            const done = await waitJob(job, (j) => { status.textContent = j.log?.at(-1) || 'Синхронизирую…'; });
            if (done.status === 'error') throw new Error(done.error);
            const r = done.result;
            status.textContent = '';
            ui.toast(`Готово: отправлено ${r.uploaded.length}, получено ${r.downloaded.length}${r.conflicts.length ? `, конфликтов ${r.conflicts.length}` : ''}`);
            renderSync();
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
        }
    };
    const last = info.last;
    put(view,
        back('#tools', 'Ещё'),
        h('div', { class: 'section' },
            mascotRow('done', 'Две таверны — одни чаты', 'Чаты, карточки, лорбуки, пресеты, фоны и галереи аватарок переносятся между этим устройством и другой таверной в обе стороны. Настройки и ключи у каждой свои и не переносятся. Ничего не удаляется: заменённые файлы уходят в резервные копии')),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Другая таверна' }),
            h('div', { class: 'field-row' }, peer),
            h('div', { class: 'field-row', style: 'margin-top:8px' }, login),
            h('div', { class: 'field-row', style: 'margin-top:8px' }, password),
            h('label', { class: 'check-row', style: 'margin-top:12px' },
                (() => { const box = h('input', { type: 'checkbox' }); box.checked = info.auto; box.addEventListener('change', () => saveSettings({ auto: box.checked }).then(() => ui.toast(box.checked ? 'Буду синхронизировать сам каждые 15 минут' : 'Только по кнопке'))); return box; })(),
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Синхронизировать самому' }), h('span', { class: 'row-sub', text: 'Каждые 15 минут, пока обе таверны работают' }))),
            h('div', { class: 'card-actions' },
                h('button', { class: 'btn primary', type: 'button', onclick: run, text: 'Синхронизировать сейчас' }),
                h('button', { class: 'btn secondary', type: 'button', onclick: test, text: 'Проверить связь' })),
            status),
        last ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: `Последний раз: ${ui.when(last.at)}` }),
            h('p', { class: 'small secondary', style: 'margin:0', text: `Отправлено ${last.uploaded}, получено ${last.downloaded}${last.conflicts?.length ? `, конфликтов ${last.conflicts.length}` : ''}${last.errors?.length ? `, ошибок ${last.errors.length}` : ''}` }),
            last.conflicts?.length ? h('ul', { class: 'tips', style: 'margin-top:8px' }, last.conflicts.map(c => h('li', { class: 'medium', text: c.copy ? `${c.name.split('/').pop()}: чат менялся на обоих устройствах. Оставлена версия с «${c.kept}», вторая сохранена отдельным чатом` : `${c.name}: менялся на обоих устройствах, оставлена версия с «${c.kept}», другая — в резервных копиях` }))) : null,
            last.errors?.length ? h('ul', { class: 'tips', style: 'margin-top:8px' }, last.errors.map(e => h('li', { class: 'high', text: e }))) : null) : null,
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Как подготовить ПК' }),
            h('ol', { class: 'steps' },
                h('li', { text: 'Поставьте Корректор и в таверну на ПК: в папке с кодом Корректора выполните node scripts/install.mjs "путь к SillyTavern"' }),
                h('li', { text: 'В config.yaml таверны на ПК: listen: true. И одно из двух: добавьте адрес телефона в whitelist или выключите whitelistMode и включите basicAuth с логином и паролем' }),
                h('li', { text: 'Перезапустите таверну на ПК и впишите сюда её адрес: в той же Wi‑Fi это http://IP-компьютера:8000, через Tailscale — адрес компьютера в Tailscale' })),
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: `Это устройство называется «${info.device}». Если писать в один чат на обоих устройствах между синхронизациями, обе версии сохранятся: более новая останется чатом, вторая появится рядом отдельным чатом` })));
}

// ---------- muted kinds ----------

export async function renderMuted() {
    const { h, put, $ } = ui;
    const view = $('#view');
    const top = ui.optimizationSwitch ? ui.optimizationSwitch('muted') : back('#feed', 'Оптимизация');
    let settings;
    try {
        settings = await ui.api('/settings');
    } catch (error) {
        put(view, top, h('div', { class: 'empty' }, h('h2', { text: 'Не удалось загрузить' }), h('p', { text: error.message })));
        return;
    }
    const muted = settings.muted || [];
    put(view,
        top,
        muted.length ? h('div', { class: 'rows' }, muted.map(kind => h('div', { class: 'row' },
            h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: ui.KIND[kind] || kind })),
            h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { await ui.api('/mute', { method: 'POST', body: { kind, muted: false } }); renderMuted(); }, text: 'Показывать снова' }))))
            : h('div', { class: 'empty' }, mascot('sleep', 140), h('h2', { text: 'Ничего не скрыто' }),
                h('p', { text: 'Если трижды отклонить замечания одного вида, Корректор спросит, не перестать ли их показывать' })));
}

/** After a rejection: three of a kind within a month — offer to stop showing them. */
export async function offerMute(result) {
    if (!result?.suggestMute) return;
    const kind = result.suggestMute;
    const ok = await ui.confirmDialog({
        title: 'Больше не предлагать такое?',
        text: `Вы уже ${result.rejectedOfKind} раза отклонили замечания «${ui.KIND[kind] || kind}». Перестать их показывать? Вернуть можно в «Ещё» → «Скрытые замечания»`,
        ok: 'Не предлагать', cancel: 'Оставить',
    });
    if (!ok) return;
    await ui.api('/mute', { method: 'POST', body: { kind, muted: true } });
    ui.toast('Хорошо, такие замечания больше не появятся');
}

// ---------- chat sheet: compress and recap ----------

function relatedToChat(p, info) {
    const avatar = info.id.startsWith('c/') ? `${info.id.split('/')[1]}.png` : null;
    return (p.chats || []).includes(info.id) || p.target?.chatId === info.id
        || (avatar && p.target?.avatar === avatar) || (p.target?.world && info.worlds.includes(p.target.world));
}

// What did not work on the last "apply selected", shown after the screen redraws.
const compressFailures = new Map();

export function compressButton(info) {
    return ui.h('a', { class: 'btn secondary small', href: `#compress/${encodeURIComponent(info.id)}`, text: 'Сжать чат' });
}

export async function renderCompress(chatId) {
    if (ui.state.status?.optimizationPaused) {
        ui.put(ui.$('#view'), ui.h('h2', { text: 'Оптимизация временно отключена' }), ui.h('p', { text: 'Сжатие чатов приостановлено из-за нестабильной работы и расхода токенов' }));
        return;
    }
    const { h, fmt, plural, state } = ui;
    ui.openSheet('Сжать чат', h('p', { class: 'muted', text: 'Собираю, что можно сократить' }));
    let info;
    try {
        info = await ui.api(`/chat?id=${encodeURIComponent(chatId)}`);
        state.proposals = (await ui.api('/proposals?status=open')).items;
    } catch (error) {
        ui.openSheet('Сжать чат', h('div', { class: 'empty' }, h('h2', { text: 'Не удалось открыть чат' }), h('p', { text: error.message })));
        return;
    }
    const list = state.proposals.filter(p => TOKEN_KINDS.includes(p.kind) && relatedToChat(p, info));
    const fixable = list.filter(p => !p.advice && ['open', 'needs_fix'].includes(p.status));
    const advice = list.filter(p => p.advice);
    const picked = new Set(fixable.map(p => p.id));
    const size = info.actual?.total || info.lastPrompt?.tokens || info.usage.total;
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const go = h('button', { class: 'btn primary', type: 'button', disabled: !fixable.length });
    const label = () => { go.textContent = picked.size ? `Применить выбранное (${picked.size})` : 'Ничего не выбрано'; go.disabled = !picked.size; };
    label();

    go.addEventListener('click', async () => {
        const chosen = fixable.filter(p => picked.has(p.id));
        const needModel = chosen.filter(p => p.status === 'needs_fix').length;
        const ok = await ui.confirmDialog({
            title: 'Применить выбранное?',
            text: `${chosen.length} ${plural(chosen.length, 'правка', 'правки', 'правок')}.${needModel ? ` Для ${needModel} модель сначала напишет текст правки — это расходует токены.` : ''} Перед каждым изменением сохраняется копия, всё можно откатить в «Истории»`,
            ok: 'Применить',
        });
        if (!ok) return;
        go.disabled = true;
        let done = 0;
        const failed = [];
        for (const p of chosen) {
            try {
                if (p.status === 'needs_fix') {
                    status.textContent = `Модель пишет правку: ${p.title}`;
                    const job = await ui.api(`/proposals/${p.id}/prepare`, { method: 'POST' });
                    const finished = await waitJob(job);
                    if (finished?.status === 'error') throw new Error(finished.error);
                }
                status.textContent = `Применяю: ${p.title}`;
                await ui.api(`/proposals/${p.id}/apply`, { method: 'POST', body: {} });
                done++;
            } catch (error) {
                failed.push(`${p.title}: ${error.message}`);
            }
        }
        status.textContent = '';
        compressFailures.set(chatId, failed);
        ui.toast(failed.length ? `Применено ${done} из ${chosen.length}. Что не получилось — на экране` : `Готово: применено ${done}. Копии сохранены`, Boolean(failed.length));
        renderCompress(chatId);
    });

    const failures = compressFailures.get(chatId) || [];
    compressFailures.delete(chatId);
    const body = [
        failures.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Не получилось' }),
            h('ul', { class: 'tips' }, failures.map(text => h('li', { class: 'high', text })))) : null,
        h('div', { class: 'with-mascot' }, mascot('squeeze', 96),
            h('div', {}, h('h1', { class: 'sheet-title', style: 'margin:0', text: info.title }),
                h('p', { class: 'secondary', style: 'margin:0', text: `Сейчас ≈${fmt(size)} токенов в каждом запросе` }))),
        fixable.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Можно сократить' }),
            h('div', { class: 'rows' }, fixable.map(p => {
                const box = h('input', { type: 'checkbox', checked: true, 'aria-label': p.title });
                box.addEventListener('change', () => { if (box.checked) picked.add(p.id); else picked.delete(p.id); label(); });
                return h('label', { class: 'row check-row' }, box,
                    h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: p.title }),
                        h('span', { class: 'row-sub', text: `${ui.KIND[p.kind] || ''}${p.status === 'needs_fix' ? ' · правку напишет модель' : ''}` })));
            }))) : h('div', { class: 'empty' }, mascot('done', 120), h('h2', { text: 'Сокращать нечего' }),
            h('p', { text: 'Корректор не нашёл, что убрать без потерь. Запустите проверку чата, если давно не проверяли' })),
        advice.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Советы: это меняется в самом SillyTavern' }),
            h('ul', { class: 'tips' }, advice.map(p => h('li', { class: 'medium', text: `${p.title}. ${p.summary}` })))) : null,
        status,
    ];
    ui.openSheet('Сжать чат', body, fixable.length ? [go] : null);
}

export function recapSection(info) {
    const { h } = ui;
    const box = h('div', { class: 'section' });
    const kindsText = (found) => Object.entries(found || {}).map(([k, n]) => `${ui.KIND[k] || k}: ${n}`).join(', ');
    const draw = (recap, busy = false) => {
        ui.put(box,
            h('h3', { class: 'section-title', text: 'Итоги сессии' }),
            busy ? h('div', { class: 'with-mascot' }, mascot('write', 64), h('p', { class: 'small secondary', text: 'Перечитываю последние сообщения…' }))
                : recap?.text ? h('div', {},
                    h('p', { class: 'prose', style: 'white-space:pre-line', text: recap.text }),
                    h('p', { class: 'small muted', style: 'margin:4px 0 0', text: [`сообщения #${recap.from}–${recap.to}`, recap.model, ui.when(recap.at)].filter(Boolean).join(' · ') }),
                    recap.found && Object.keys(recap.found).length ? h('p', { class: 'small secondary', style: 'margin:4px 0 0', text: `Корректор за это время нашёл: ${kindsText(recap.found)}` }) : null)
                    : h('p', { class: 'small secondary', style: 'margin:0', text: 'Короткий пересказ: что произошло с прошлого раза и на чём остановились. Пишет дешёвая модель' }),
            busy ? null : h('div', { class: 'card-actions' }, h('button', { class: 'btn secondary small', type: 'button', onclick: run, text: recap?.text ? 'Что нового' : 'Подвести итоги' })));
    };
    const run = async () => {
        draw(null, true);
        try {
            const job = await ui.api('/recap', { method: 'POST', body: { chatId: info.id } });
            const done = await waitJob(job);
            if (done.status === 'error') throw new Error(done.error);
            if (done.result?.nothingNew) ui.toast('Новых сообщений с прошлых итогов нет');
            draw(done.result);
        } catch (error) {
            ui.toast(error.message, true);
            draw(info.recap);
        }
    };
    draw(info.recap);
    return box;
}

// ---------- theme ----------

export const ACCENTS = [['amber', 'Янтарь'], ['rose', 'Роза'], ['mint', 'Мята'], ['sky', 'Небо'], ['lavender', 'Лаванда']];
/** Themes to choose from. Black and white were near copies of dark and light: saved ones map to those. */
export const THEMES = [['dark', 'Тёмная'], ['light', 'Светлая'], ['midnight', 'Полночь'], ['mist', 'Туман'], ['brown', 'Коричневая']];

export function themeName(theme) {
    if (theme === 'black') return 'dark';
    if (theme === 'white') return 'light';
    return THEMES.some(([key]) => key === theme) ? theme : '';
}

export function applyTheme(theme, accent) {
    const root = document.documentElement;
    const name = themeName(theme);
    if (name) root.dataset.theme = name;
    else delete root.dataset.theme;
    if (accent && accent !== 'amber') root.dataset.accent = accent;
    else delete root.dataset.accent;
    refreshMascots();
}
