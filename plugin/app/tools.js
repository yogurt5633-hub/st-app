// Корректор: the "Ещё" tab and the tools behind it — spending, card health,
// full backup, import by link, catalog, key check — plus the chat sheet parts
// "Сжать чат" and "Итоги сессии". Helpers come from app.js through setup().

let ui = null;

export function setup(helpers) {
    ui = helpers;
}

const TOKEN_KINDS = ['context', 'preset_bloat', 'prompt_reasoning', 'prompt_html', 'advice', 'lore_keyed', 'lore_card_dup', 'lore_bloat', 'card_bloat'];

export function mascot(name, size = 120, alt = '') {
    return ui.h('img', { class: 'mascot', src: `img/${name}.png`, width: size, height: size, alt, loading: 'lazy' });
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
            row('#tools/sync', 'Связь с ПК', 'Чаты, карточки и лорбуки одинаковые на телефоне и компьютере'),
            row('#tools/spend', 'Расходы', 'Сколько токенов и денег ушло: ролёвка и проверки'),
            row('#tools/cards', 'Здоровье карточек', 'Оценка каждой карточки и что поправить'),
            row('#tools/backup', 'Резервная копия', 'Чаты, карточки, лорбуки и настройки в одном файле'),
            row('#tools/import', 'Импорт по ссылке', 'Карточка или лорбук с Chub, JanitorAI и других сайтов'),
            row('#tools/catalog', 'Каталог', 'Пресеты, лорбуки и карточки от авторов'),
            row('#tools/muted', 'Скрытые замечания', 'Виды замечаний, которые вы попросили не показывать')),
        renderKeyCheck());
}

// ---------- key check ----------

export function renderKeyCheck() {
    const { h, state } = ui;
    const last = state.status?.connectionCheck;
    const box = h('div', { class: 'section key-check' });
    const draw = (result, busy = false) => {
        const tone = result?.ok === true ? 'pos' : result?.ok === false ? 'neg' : '';
        ui.put(box,
            h('div', { class: 'with-mascot' },
                mascot(result?.ok === false ? 'confused' : 'key', 72),
                h('div', {},
                    h('h3', { class: 'section-title', text: 'Подключение к модели' }),
                    h('p', { class: `small ${tone}`, style: 'margin:0', text: busy ? 'Проверяю…' : result ? result.message : 'Проверю, принимает ли провайдер ключ, сохранённый в SillyTavern. Сам ключ Корректор не видит' }),
                    result?.model ? h('p', { class: 'small muted', style: 'margin:4px 0 0', text: `${result.source || ''} · ${result.model}${result.at ? ` · ${ui.when(result.at)}` : ''}` }) : null)),
            h('div', { class: 'card-actions' },
                h('button', { class: 'btn secondary small', type: 'button', disabled: busy, onclick: () => run(false), text: 'Проверить' }),
                result?.ok === null ? h('button', { class: 'btn secondary small', type: 'button', disabled: busy, onclick: () => run(true), text: 'Пробный запрос' }) : null));
    };
    const run = async (test) => {
        draw(last, true);
        try {
            const result = await ui.api('/connection-check', { method: 'POST', body: { test }, timeout: 120000 });
            if (state.status) state.status.connectionCheck = result;
            draw(result);
        } catch (error) {
            draw({ ok: false, message: error.message });
        }
    };
    draw(last);
    return box;
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
            h('p', { text: 'Расходы ролёвки считаются после каждого ответа, если в SillyTavern стоит расширение «Корректор: синхронизация». Проверки Корректора считаются сами' })) : null);
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
    put(view, back('#tools', 'Ещё'), h('p', { class: 'muted', text: 'Читаю карточки' }));
    let items;
    try {
        items = (await ui.api('/cards-health')).items;
    } catch (error) {
        put(view, back('#tools', 'Ещё'), h('div', { class: 'empty' }, h('h2', { text: 'Не удалось прочитать карточки' }), h('p', { text: error.message })));
        return;
    }
    put(view, back('#tools', 'Ещё'),
        h('p', { class: 'small muted', text: 'Сначала те, что стоит поправить. Оценка без модели: размер, пустые поля, лишняя разметка, повторы и открытые замечания' }),
        items.length ? h('div', { class: 'rows' }, items.map(c => h('a', { class: 'row row-link', href: `#card/${encodeURIComponent(c.avatar)}` },
            h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: c.name }), h('span', { class: 'row-sub', text: `${c.verdict} · ≈${fmt(c.tokens)} токенов` })),
            scoreTag(c.score))))
            : h('div', { class: 'empty' }, mascot('sleep', 140), h('h2', { text: 'Карточек нет' })));
}

export async function renderCardHealth(avatar, { inSheet = false } = {}) {
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
    if (!inSheet) put($('#view'), body);
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

export async function importFromUrl(url, status) {
    const set = (text) => { if (status) status.textContent = text; };
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) throw new Error('Нужна ссылка, которая начинается с https://');
    set('Скачиваю через SillyTavern…');
    const token = await ui.csrfToken();
    const res = await fetch('/api/content/importURL', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ url: value }) });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(res.status === 404 ? 'SillyTavern не нашёл файл по этой ссылке' : `SillyTavern не смог скачать: ${text.slice(0, 200) || res.status}`);
    }
    const type = res.headers.get('X-Custom-Content-Type') || 'character';
    const disposition = res.headers.get('Content-Disposition') || '';
    const name = decodeURIComponent((disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1] || (type === 'lorebook' ? 'lorebook.json' : 'character.png'));
    const blob = await res.blob();
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    const form = new FormData();
    form.append('avatar', file);
    set('Добавляю в SillyTavern…');
    let target;
    if (type === 'lorebook') {
        target = '/api/worldinfo/import';
    } else {
        target = '/api/characters/import';
        form.append('file_type', (name.split('.').pop() || 'png').toLowerCase());
    }
    const imported = await fetch(target, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': token }, body: form });
    const data = await imported.json().catch(() => ({}));
    if (!imported.ok || data.error) throw new Error('SillyTavern не принял файл: возможно, это не карточка и не лорбук');
    await ui.api('/refresh', { method: 'POST', body: { type: type === 'lorebook' ? 'world' : 'card' } }).catch(() => { });
    return { type, name: data.file_name || data.name || name.replace(/\.[^.]+$/, '') };
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

// ---------- catalog ----------

// ---------- catalog ----------

const CATALOG_NAMES = { preset: 'Пресет', lorebook: 'Лорбук', card: 'Карточка' };
const CATALOG_TYPES = [['preset', 'Пресет'], ['lorebook', 'Лорбук'], ['card', 'Карточка']];
// Loaded once per visit: switching between presets, lorebooks and cards only filters it.
let catalogData = null;
let catalogAt = 0;

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

function catalogEntry(item, extra) {
    const { h } = ui;
    return h('article', { class: 'card catalog-item' },
        item.type === 'card' ? h('img', { class: 'catalog-thumb', src: item.url, alt: '', loading: 'lazy', decoding: 'async', width: 64, height: 86 }) : null,
        h('div', { class: 'catalog-body' },
            h('div', { class: 'card-meta' }, h('span', { class: 'status-tag', text: CATALOG_NAMES[item.type] }), item.author ? h('span', { class: 'meta', text: item.author }) : null),
            h('h2', { class: 'card-title', text: item.name }),
            item.description ? h('p', { class: 'card-summary', text: item.description }) : null,
            item.tags.length ? h('p', { class: 'small muted', style: 'margin:0', text: item.tags.join(' · ') }) : null,
            h('div', { class: 'card-actions' }, extra)));
}

export async function renderCatalog() {
    const { h, put, $ } = ui;
    const view = $('#view');
    let filter = ui.storageGet('korrektor.catalogFilter') || 'all';
    if (!catalogData) put(view, back('#tools', 'Ещё'), h('p', { class: 'muted', text: 'Загружаю каталог' }));
    const data = await loadCatalogData();
    if (location.hash !== '#tools/catalog') return;

    const install = async (item, button) => {
        const ok = await ui.confirmDialog({ title: `Установить «${item.name}»?`, text: `${CATALOG_NAMES[item.type]} от ${item.author || 'автора'} скачается в SillyTavern. Ваши файлы не перезаписываются: если имя занято, у нового будет номер`, ok: 'Установить' });
        if (!ok) return;
        button.disabled = true;
        try {
            const result = await ui.api('/catalog/install', { method: 'POST', body: { id: item.id }, timeout: 120000 });
            ui.toast(`Установлено: ${result.where} → ${result.name}`);
        } catch (error) {
            ui.toast(error.message, true);
        } finally {
            button.disabled = false;
        }
    };
    const list = h('div', { class: 'list catalog-list' });
    const drawList = () => {
        const items = data.items.filter(i => filter === 'all' || i.type === filter);
        put(list, items.length ? items.map(item => {
            const button = h('button', { class: 'btn primary small', type: 'button', text: 'Установить' });
            button.addEventListener('click', () => install(item, button));
            return catalogEntry(item, [button, item.page ? h('a', { class: 'btn secondary small', href: item.page, target: '_blank', rel: 'noopener', text: 'Страница автора' }) : null]);
        }) : h('div', { class: 'empty' }, mascot('books', 150),
            h('h2', { text: data.items.length ? 'В этом разделе пусто' : 'Каталог пока пуст' }),
            h('p', { text: 'Сюда попадают пресеты, лорбуки и карточки, которые авторы разрешили распространять' })));
    };
    const filters = h('div', { class: 'filters' }, [['all', 'Все'], ['preset', 'Пресеты'], ['lorebook', 'Лорбуки'], ['card', 'Карточки']].map(([v, text]) =>
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
        back('#tools', 'Ещё'),
        filters,
        data.error ? h('p', { class: 'small', style: 'color:var(--del-text)', text: data.error }) : null,
        list,
        h('div', { class: 'section' },
            h('div', { class: 'card-actions', style: 'margin-top:0' },
                h('a', { class: 'btn secondary', href: '#tools/catalog-suggest', text: 'Предложить своё' }),
                h('button', { class: 'btn quiet', type: 'button', text: 'Обновить список', onclick: async () => { await loadCatalogData(true); renderCatalog(); } })),
            h('p', { class: 'small muted', style: 'margin:12px 0 0' }, 'Каталог ведёт автор Корректора. ', h('a', { href: '#tools/catalog-author', text: 'Для автора каталога' }))));
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
        select.disabled = !items.length;
    }).catch((error) => {
        select.replaceChildren(h('option', { value: '', text: error.message }));
    });
    select.addEventListener('change', () => onchange(select.value, select.selectedOptions[0]?.textContent || ''));
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
    const save = h('a', { class: 'btn primary', download: '', text: 'Сохранить файл' });
    save.hidden = true;
    const note = h('p', { class: 'small muted', style: 'margin:8px 0 0' });
    const pickerBox = h('div', { style: 'margin-top:12px' });
    const template = h('textarea', { class: 'input', rows: 7, style: 'width:100%;height:auto;padding:10px 12px;resize:vertical' });
    const fillTemplate = (name = '') => {
        template.value = `Хочу предложить в каталог Корректора\nТип: ${CATALOG_NAMES[type].toLowerCase()}\nНазвание: ${name}\nАвтор: \nЧто это (пара предложений): \nАвтор разрешил распространять: да`;
    };
    const drawPicker = () => {
        file = '';
        save.hidden = true;
        note.textContent = type === 'preset' ? 'Пароли, адреса прокси и всё похожее на ключи из пресета при сохранении убираются' : '';
        put(pickerBox, localPicker(type, (value, name) => {
            file = value;
            save.hidden = !value;
            if (value) save.href = `${ui.BASE}/catalog/export?type=${type}&file=${encodeURIComponent(value)}`;
            fillTemplate(value ? name : '');
        }));
        fillTemplate();
    };
    save.addEventListener('click', () => ui.toast(inApp() ? 'Сохраняю в Загрузки/Korrektor' : 'Скачивание началось'));
    const link = data.submit;
    // A Telegram chat with a person or a bot can open with the text already typed.
    const telegram = () => {
        let url = link;
        if (/^https:\/\/t\.me\/[A-Za-z0-9_]{4,}\/?$/.test(link)) url = `${link.replace(/\/$/, '')}?text=${encodeURIComponent(template.value)}`;
        window.open(url, '_blank', 'noopener');
    };
    drawPicker();
    put(view,
        back('#tools/catalog', 'Каталог'),
        h('div', { class: 'section' },
            mascotRow('books', 'Поделиться своим', 'Пресеты, лорбуки и карточки в каталог добавляет его автор. Пришлите ему файл с названием, автором и парой слов о том, что это. Чужое — только с разрешения автора')),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: '1. Файл из вашей таверны' }),
            pick(CATALOG_TYPES, type, (v) => { type = v; drawPicker(); }),
            pickerBox,
            h('div', { class: 'card-actions' }, save),
            note),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: '2. Сообщение автору каталога' }),
            template,
            h('div', { class: 'card-actions' },
                link ? h('button', { class: 'btn primary', type: 'button', text: 'Открыть Telegram', onclick: telegram }) : null,
                h('button', { class: 'btn secondary', type: 'button', text: 'Скопировать текст', onclick: async () => ui.toast(await copyText(template.value) ? 'Текст скопирован' : 'Не удалось скопировать: выделите текст вручную', false) })),
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: link ? 'В Telegram прикрепите сохранённый файл (скрепка → Файл → Загрузки/Korrektor) и отправьте вместе с текстом' : 'Автор каталога пока не указал, куда присылать: напишите в Telegram-канал Корректора и прикрепите файл' })));
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
    const field = (label, input, hint) => h('label', { class: 'author-field' }, h('span', { class: 'small secondary', text: label }), input, hint ? h('span', { class: 'small muted', text: hint }) : null);
    const name = h('input', { class: 'input', style: 'width:100%', type: 'text', maxlength: 80 });
    const author = h('input', { class: 'input', style: 'width:100%', type: 'text', maxlength: 60 });
    const description = h('textarea', { class: 'input', rows: 3, maxlength: 400, style: 'width:100%;height:auto;padding:10px 12px;resize:vertical' });
    const tags = h('input', { class: 'input', style: 'width:100%', type: 'text', placeholder: 'фэнтези, ромком' });
    const page = h('input', { class: 'input', style: 'width:100%', type: 'url', placeholder: 'https://… (необязательно)', autocapitalize: 'off' });
    const allowed = h('input', { type: 'checkbox' });
    const status = h('p', { class: 'small secondary', style: 'margin:8px 0 0' });
    const sourceBox = h('div', { style: 'margin-top:12px' });
    const fileInput = h('input', { type: 'file', hidden: true });
    let autoName = '';
    const setName = (value) => {
        if (!name.value || name.value === autoName) name.value = value;
        autoName = value;
    };
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f) return;
        status.textContent = 'Проверяю файл…';
        upload = '';
        try {
            const token = await ui.csrfToken();
            const res = await fetch(`${ui.BASE}/catalog/upload?type=${type}&name=${encodeURIComponent(f.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': token, 'X-Korrektor': '1' }, body: f });
            const r = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(r.error || `Ошибка ${res.status}`);
            upload = r.upload;
            setName(r.title);
            status.textContent = `Файл подходит: ${f.name}${r.removed?.length ? `. Из пресета убрано: ${r.removed.join(', ')}` : ''}`;
        } catch (error) {
            status.textContent = '';
            ui.toast(error.message, true);
        } finally {
            fileInput.value = '';
        }
    });
    const drawSource = () => {
        file = '';
        upload = '';
        fileInput.accept = type === 'card' ? '.png,image/png' : '.json,application/json';
        if (source === 'local') {
            put(sourceBox, localPicker(type, (value, label) => { file = value; if (value) setName(label); }));
        } else {
            put(sourceBox, h('button', { class: 'btn secondary', type: 'button', text: 'Выбрать файл', onclick: () => fileInput.click() }), fileInput);
        }
        status.textContent = '';
    };
    const publish = async (e) => {
        const button = e.currentTarget;
        if (source === 'local' ? !file : !upload) return ui.toast('Сначала выберите файл', true);
        button.disabled = true;
        status.textContent = 'Публикую на GitHub…';
        try {
            const r = await ui.api('/catalog/publish', {
                method: 'POST', timeout: 120000,
                body: { type, file: source === 'local' ? file : undefined, upload: source === 'upload' ? upload : undefined, meta: { name: name.value, author: author.value, description: description.value, tags: tags.value, page: page.value, allowed: allowed.checked } },
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
    const submit = h('input', { class: 'input', style: 'width:100%', type: 'url', value: data.submit || '', placeholder: 'https://t.me/ваш_ник', autocapitalize: 'off' });
    const saveSubmit = async () => {
        try {
            await ui.api('/catalog/submit-link', { method: 'POST', body: { link: submit.value.trim() } });
            catalogData = null;
            ui.toast(submit.value.trim() ? 'Ссылка сохранена: кнопка «Предложить своё» ведёт туда' : 'Ссылка убрана');
        } catch (error) {
            ui.toast(error.message, true);
        }
    };
    const remove = async (item, button) => {
        const ok = await ui.confirmDialog({ title: `Убрать «${item.name}»?`, text: 'Запись исчезнет из каталога у всех. У тех, кто уже установил, файл останется', ok: 'Убрать', danger: true });
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
    drawSource();
    put(view,
        back('#tools/catalog', 'Каталог'),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Добавить в каталог' }),
            pick(CATALOG_TYPES, type, (v) => { type = v; drawSource(); }),
            h('div', { style: 'margin-top:8px' }, pick([['local', 'Из таверны'], ['upload', 'Файл с телефона']], source, (v) => { source = v; drawSource(); })),
            sourceBox,
            h('div', { class: 'author-fields' },
                field('Название', name),
                field('Автор', author, 'Указывается в каталоге всегда'),
                field('Что это', description, 'Пара предложений: для чего и чем хорош'),
                field('Теги', tags, 'Через запятую'),
                field('Страница автора', page)),
            h('label', { class: 'check-row', style: 'margin-top:12px' }, allowed,
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: 'Автор разрешил распространять' }), h('span', { class: 'row-sub', text: 'Без этого опубликовать нельзя' }))),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', type: 'button', text: 'Опубликовать', onclick: publish })),
            status,
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Из пресетов при публикации убираются пароли, адреса прокси и всё похожее на ключи' })),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Куда присылать предложения' }),
            h('div', { class: 'field-row' }, submit),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn secondary', type: 'button', text: 'Сохранить ссылку', onclick: saveSubmit })),
            h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Ссылка на ваш Telegram (https://t.me/ник) или чат канала. По ней пользователи пришлют файлы с кнопки «Предложить своё»' })),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: `В каталоге сейчас: ${data.items.length}` }),
            data.items.length ? h('div', { class: 'list catalog-list' }, data.items.map(item => {
                const button = h('button', { class: 'btn quiet small', type: 'button', text: 'Убрать' });
                button.addEventListener('click', () => remove(item, button));
                return catalogEntry(item, [button]);
            })) : h('p', { class: 'small muted', text: 'Пока пусто' })),
        h('div', { class: 'section' },
            h('p', { class: 'small muted', style: 'margin:0', text: `Публикуется в ${admin.repo}${admin.login ? ` от имени ${admin.login}` : ''}` }),
            h('div', { class: 'card-actions' }, h('button', { class: 'btn quiet small', type: 'button', text: 'Удалить токен', onclick: forget }))));
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
    let settings;
    try {
        settings = await ui.api('/settings');
    } catch (error) {
        put(view, back('#tools', 'Ещё'), h('div', { class: 'empty' }, h('h2', { text: 'Не удалось загрузить' }), h('p', { text: error.message })));
        return;
    }
    const muted = settings.muted || [];
    put(view,
        back('#tools', 'Ещё'),
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

export function applyTheme(theme, accent) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (accent && accent !== 'amber') root.dataset.accent = accent;
    else delete root.dataset.accent;
}
