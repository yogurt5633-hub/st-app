// Корректор: the phone app. Plain JS, no build step.
// All chat text is inserted with textContent, never as HTML.

import { diffWords } from './diff.js';
import * as tools from './tools.js';

const APP_VERSION = '0.4.22';
const BASE = location.pathname.replace(/\/app\/.*$/, '').replace(/\/app$/, '');
const $ = (sel) => document.querySelector(sel);

const KIND = {
    context: 'Контекст',
    repetition: 'Повторы',
    slop: 'Штампы',
    new_fact: 'Новый факт',
    contradiction: 'Противоречие',
    rewrite: 'Переписать',
    lore_duplicate: 'Дубли',
    lore_keys: 'Ключи',
    lore_bloat: 'Объём лорбука',
    lore_keyed: 'Объём лорбука',
    lore_card_dup: 'Повтор карточки',
    card_bloat: 'Объём карточки',
    preset_bloat: 'Пресет',
    prompt_reasoning: 'Рассуждения',
    prompt_html: 'HTML',
    advice: 'Совет',
    request: 'Просьба',
    manual: 'Изменение',
};
const GROUP = {
    chats: ['context', 'repetition', 'slop', 'new_fact', 'contradiction', 'rewrite', 'request'],
    tokens: ['preset_bloat', 'prompt_reasoning', 'prompt_html', 'advice', 'lore_keyed', 'lore_card_dup'],
    lore: ['lore_duplicate', 'lore_keys', 'lore_bloat'],
    cards: ['card_bloat'],
};
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const STATUS_TEXT = {
    open: 'Ждёт решения',
    needs_fix: 'Правка не готова',
    preparing: 'Модель пишет правку',
    applied: 'Применено',
    rejected: 'Отклонено',
    reverted: 'Откачено',
    stale: 'Устарело',
    failed: 'Ошибка',
};
const TASKS = [
    ['facts', 'Поиск новых фактов'],
    ['contradictions', 'Поиск противоречий'],
    ['fixContradiction', 'Исправление противоречий'],
    ['rewriteMessage', 'Переписывание ответов'],
    ['summary', 'Резюме старых сообщений'],
    ['condenseCard', 'Сжатие карточек'],
    ['condenseEntry', 'Сжатие и слияние записей лорбука'],
    ['condensePrompt', 'Сжатие промптов пресета'],
    ['ask', 'Просьбы к Корректору'],
    ['recap', 'Пересказ «что было»'],
    ['translate', 'Перевод сообщений в чате'],
];
const ANALYZERS = [
    ['context', 'Переполнение контекста', 'Предлагает резюме старых сообщений'],
    ['repetition', 'Повторы и зацикливание', 'Без модели'],
    ['slop', 'Штампы', 'Типичные обороты моделей, без модели'],
    ['facts', 'Новые факты', 'Имена, места, отношения → лорбук. Нужна модель'],
    ['contradictions', 'Противоречия', 'С карточкой, лорбуком и прошлым. Нужна модель'],
    ['loreDuplicates', 'Дубли в лорбуках', 'Без модели'],
    ['loreKeys', 'Плохие ключи', 'Без модели'],
    ['bloat', 'Раздутые карточки и записи', 'Без модели, сжатие делает модель'],
    ['tokens', 'Куда уходят токены', 'Пресет, HTML, рассуждения, лорбук, векторы, персона'],
];
// Chat Completion sources of SillyTavern. Any of them works if its key is saved in SillyTavern.
const SOURCES = [
    ['claude', 'Claude'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'], ['makersuite', 'Google AI Studio'],
    ['vertexai', 'Google Vertex AI'], ['deepseek', 'DeepSeek'], ['mistralai', 'Mistral'], ['xai', 'xAI'],
    ['groq', 'Groq'], ['cohere', 'Cohere'], ['perplexity', 'Perplexity'], ['moonshot', 'Moonshot'],
    ['zai', 'Z.AI'], ['chutes', 'Chutes'], ['nanogpt', 'NanoGPT'], ['electronhub', 'Electron Hub'],
    ['aimlapi', 'AI/ML API'], ['fireworks', 'Fireworks'], ['cometapi', 'CometAPI'], ['siliconflow', 'SiliconFlow'],
    ['minimax', 'MiniMax'], ['pollinations', 'Pollinations'], ['workers_ai', 'Workers AI'], ['azure_openai', 'Azure OpenAI'],
    ['ai21', 'AI21'], ['custom', 'Свой адрес (Custom)'],
];
const SOURCE_NAME = Object.fromEntries(SOURCES);
const RECOMMENDED = { scan: 'claude-haiku-5-5', heavy: 'claude-opus-5-5' };

const state = {
    status: null,
    proposals: [],
    history: [],
    chats: [],
    settings: null,
    worlds: [],
    backups: [],
    filter: 'all',
    feedChat: storageGet('korrektor.feedChat') || 'all',
    chatQuery: '',
    chatsView: 'all',
    historyTab: 'changes',
    job: null,
    overrides: {},
    modes: {},
    expanded: {},
    csrf: null,
    modelLists: {},
    ask: {},
    offline: false,
    needLogin: false,
};

// ---------- per-device conveniences ----------

function storageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // private mode or storage off: the filter just resets next time
    }
}

// ---------- API ----------

async function csrfToken(force = false) {
    if (state.csrf && !force) return state.csrf;
    const res = await fetch('/csrf-token', { credentials: 'same-origin' });
    if (!res.ok) throw Object.assign(new Error('Нет доступа к SillyTavern'), { status: res.status });
    state.csrf = (await res.json()).token;
    return state.csrf;
}

async function api(path, { method = 'GET', body, timeout = 90000 } = {}, retry = true) {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const token = await csrfToken();
        res = await fetch(`${BASE}${path}`, {
            method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Korrektor': '1' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (error) {
        clearTimeout(timer);
        if (error.name === 'AbortError') throw new Error('SillyTavern долго не отвечает. Попробуйте ещё раз');
        if (error.status === 403 || error.status === 401) {
            state.needLogin = true;
            renderBanner();
        } else {
            state.offline = true;
            renderBanner();
        }
        throw new Error(error.status ? error.message : 'SillyTavern не отвечает');
    }
    clearTimeout(timer);
    state.offline = false;
    if (res.status === 403 && retry) {
        state.csrf = null;
        return api(path, { method, body }, false);
    }
    if (res.status === 403 || res.status === 401) {
        state.needLogin = true;
        renderBanner();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const error = new Error(data.error || `Ошибка ${res.status}`);
        Object.assign(error, { status: res.status, canForce: data.canForce });
        throw error;
    }
    state.needLogin = false;
    renderBanner();
    return data;
}

// ---------- tiny DOM helper ----------

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
        else if (key === 'style') el.style.cssText = value;
        else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

/** Like el.replaceChildren, but skips empty values (null would be shown as the word "null"). */
function put(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false));
}

function icon(name) {
    const paths = {
        back: '<path d="M15 6l-6 6 6 6"/>',
        chev: '<path d="M9 6l6 6-6 6"/>',
    };
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
    return span.firstChild;
}

function fmt(n) {
    return Math.round(Number(n) || 0).toLocaleString('ru-RU');
}

function when(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return `в ${time}`;
    const yesterday = new Date(today.getTime() - 864e5);
    if (date.toDateString() === yesterday.toDateString()) return `вчера в ${time}`;
    return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} в ${time}`;
}

function toast(text, isError = false) {
    const el = $('#toast');
    el.textContent = text;
    el.className = `toast${isError ? ' error' : ''}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

function confirmDialog({ title, text, ok = 'Да', cancel = 'Отмена', danger = false }) {
    return new Promise(resolve => {
        const root = $('#dialog');
        const close = (value) => {
            root.hidden = true;
            put(root, );
            resolve(value);
        };
        put(root, h('div', { class: 'dialog-box', role: 'dialog', 'aria-modal': 'true' },
            h('h2', { text: title }),
            text ? h('p', { text }) : null,
            h('div', { class: 'dialog-actions' },
                h('button', { class: 'btn secondary', type: 'button', onclick: () => close(false), text: cancel }),
                h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => close(true), text: ok }),
            ),
        ));
        root.onclick = (e) => { if (e.target === root) close(false); };
        root.hidden = false;
        root.querySelector('.btn.primary, .btn.danger')?.focus();
    });
}

// ---------- data ----------

async function loadStatus() {
    state.status = await api('/status');
    renderTop();
    renderBanner();
    if (state.status.scanning && !state.job) followJob(state.status.scanning);
}

async function loadProposals() {
    state.proposals = (await api('/proposals?status=open')).items;
    renderTop();
}

async function loadHistory() {
    state.history = (await api('/proposals?status=closed')).items;
}

// ---------- jobs ----------

async function followJob(job) {
    state.job = job;
    renderTop();
    while (state.job && state.job.status === 'running') {
        await new Promise(r => setTimeout(r, 1200));
        try {
            state.job = await api(`/jobs/${job.id}`);
        } catch {
            break;
        }
        if (currentRoute().name === 'feed') renderScanline();
        if (state.job?.kind === 'prepare' && currentRoute().name === 'proposal') renderRoute();
    }
    const done = state.job;
    state.job = null;
    if (done?.kind === 'scan') {
        if (done.status === 'error') toast(done.error, true);
        else toast(done.result?.added ? `Новых карточек: ${done.result.added}` : 'Новых проблем не найдено');
    }
    if (done?.kind === 'prepare' && done.status === 'error') toast(done.error, true);
    await Promise.allSettled([loadStatus(), loadProposals()]);
    renderRoute();
    return done;
}

const remarksOff = () => state.status?.remarks === false;

/**
 * Remarks on or off at all. Off: Korrektor checks nothing and shows no findings; what the person
 * asked for (Ask Korrektor), translation, the catalog, spending and backups keep working.
 */
async function setRemarks(on, { ask = true } = {}) {
    if (!on && ask) {
        const ok = await confirmDialog({
            title: 'Выключить замечания?',
            text: 'Корректор перестанет проверять чаты, лорбуки и карточки и присылать находки. Перевод, каталог, расходы, резервные копии и «Попросить Корректора» продолжат работать. Включить снова можно в ленте или в Настройках',
            ok: 'Выключить',
        });
        if (!ok) return;
    }
    try {
        await api('/remarks', { method: 'POST', body: { enabled: on } });
        if (state.settings) state.settings.scan.enabled = on;
        toast(on ? 'Замечания включены: Корректор снова проверяет чаты' : 'Замечания выключены');
        await Promise.allSettled([loadStatus(), loadProposals()]);
        renderRoute();
    } catch (error) {
        toast(error.message, true);
    }
}

async function startScan(chatIds = null) {
    if (state.job?.kind === 'scan') return;
    if (remarksOff()) {
        toast('Замечания выключены: включите их, чтобы проверить чаты', true);
        return;
    }
    try {
        const job = await api('/scan', { method: 'POST', body: { chatIds } });
        followJob(job);
    } catch (error) {
        toast(error.message, true);
    }
}

// ---------- routing ----------

function currentRoute() {
    const hash = decodeURIComponent(location.hash.slice(1) || 'feed');
    if (hash.startsWith('p/')) return { name: 'proposal', id: hash.slice(2) };
    if (hash.startsWith('chat/')) return { name: 'chat', id: hash.slice(5) };
    if (hash.startsWith('compress/')) return { name: 'compress', id: hash.slice(9) };
    if (hash.startsWith('card/')) return { name: 'card', id: hash.slice(5) };
    if (hash.startsWith('tools/')) return { name: 'tool', id: hash.slice(6) };
    return { name: ['feed', 'chats', 'history', 'settings', 'tools'].includes(hash) ? hash : 'feed' };
}

async function renderRoute() {
    const route = currentRoute();
    const sheet = $('#sheet');
    const tabName = route.name === 'proposal' ? 'feed' : ['chat', 'compress'].includes(route.name) ? 'chats' : ['tool', 'card'].includes(route.name) ? 'tools' : route.name;
    for (const tab of document.querySelectorAll('.tab')) {
        if (tab.dataset.tab === tabName) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    openSheet.hash = location.hash;
    if (route.name === 'proposal') return renderProposalSheet(route.id);
    if (route.name === 'chat') return renderChatSheet(route.id);
    if (route.name === 'compress') return tools.renderCompress(route.id);
    sheet.hidden = true;
    put(sheet, );
    // Each page gets a fresh container. A page still loading after an earlier tap then
    // finishes into the old, detached one, instead of piling up on top of this page.
    const oldView = $('#view');
    const freshView = oldView.cloneNode(false);
    oldView.replaceWith(freshView);
    document.body.style.overflow = '';
    const toolTitles = { sync: 'Связь с ПК', spend: 'Расходы', cards: 'Здоровье карточек', backup: 'Резервная копия', import: 'Импорт по ссылке', catalog: 'Каталог', 'catalog-suggest': 'Предложить в каталог', 'catalog-author': 'Ведение каталога', incoming: 'Файл получен', muted: 'Скрытые замечания' };
    const titles = { feed: 'Лента', chats: 'Чаты', history: 'История', settings: 'Настройки', tools: 'Ещё', card: 'Карточка', tool: toolTitles[route.id] || (String(route.id || '').startsWith('catalog-edit/') ? 'Изменить запись' : 'Ещё') };
    $('#page-title').textContent = titles[route.name];
    if (route.name === 'tools') return tools.renderTools();
    if (route.name === 'card') return tools.renderCardHealth(route.id);
    if (route.name === 'tool') {
        if (route.id === 'spend') return tools.renderSpend();
        if (route.id === 'sync') return tools.renderSync();
        if (route.id === 'cards') return tools.renderCardsHealth();
        if (route.id === 'backup') return tools.renderBackup();
        if (route.id === 'import') return tools.renderImport(state.importUrl || '');
        if (route.id === 'catalog') return tools.renderCatalog();
        if (route.id === 'catalog-suggest') return tools.renderCatalogSuggest();
        if (route.id === 'catalog-author') return tools.renderCatalogAuthor();
        if (route.id === 'incoming') return tools.renderIncoming();
        if (route.id.startsWith('catalog-edit/')) return tools.renderCatalogEdit(decodeURIComponent(route.id.slice('catalog-edit/'.length)));
        if (route.id === 'muted') return tools.renderMuted();
        return tools.renderTools();
    }
    if (route.name === 'feed') return renderFeed();
    if (route.name === 'chats') return renderChats();
    if (route.name === 'history') return renderHistory();
    return renderSettings();
}

// ---------- top bar ----------

function renderTop() {
    const open = state.proposals.filter(p => ['open', 'needs_fix', 'preparing'].includes(p.status)).length;
    $('#feed-count').textContent = open ? String(open) : '';
    const scanning = state.job?.kind === 'scan';
    $('#scan-button').classList.toggle('busy', scanning);
    $('#scan-button').disabled = scanning;
    // Remarks off: nothing to check.
    $('#scan-button').hidden = remarksOff();
    const last = state.status?.lastScan;
    $('#scan-meta').textContent = remarksOff() ? '' : scanning ? 'проверка' : last ? when(last.at) : '';
    if ('setAppBadge' in navigator) {
        (open ? navigator.setAppBadge(open) : navigator.clearAppBadge()).catch(() => { });
    }
}

function renderBanner() {
    const el = $('#banner');
    const pluginVersion = state.status?.version;
    if (pluginVersion && pluginVersion !== APP_VERSION && !state.needLogin && !state.offline) {
        put(el, h('strong', { text: 'Версии не совпадают' }), `: приложение ${APP_VERSION}, плагин ${pluginVersion}. `,
            'Перезапустите SillyTavern в Termux и обновите эту страницу. Если не помогло, запустите установщик ещё раз');
        el.hidden = false;
        return;
    }
    if (state.needLogin) {
        put(el, h('strong', { text: 'Нет входа в SillyTavern' }), '. ',
            'Откройте ', h('a', { href: '/', text: 'SillyTavern' }), ', войдите и вернитесь сюда');
        el.hidden = false;
    } else if (state.offline) {
        put(el, h('strong', { text: 'SillyTavern не запущен' }), '. ',
            'Запустите его в Termux (виджет «Корректор» или команда ./start.sh), затем обновите страницу');
        el.hidden = false;
    } else {
        el.hidden = true;
    }
}

// ---------- feed ----------

function proposalGroup(p) {
    for (const [group, kinds] of Object.entries(GROUP)) if (kinds.includes(p.kind)) return group;
    return 'chats';
}

function sortedFeed() {
    const active = (p) => ['open', 'needs_fix', 'preparing'].includes(p.status);
    return state.proposals.slice().sort((a, b) =>
        (active(b) - active(a))
        || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
        || (a.updatedAt < b.updatedAt ? 1 : -1));
}

function renderScanline() {
    const holder = $('#scanline');
    if (!holder) return;
    const job = state.job;
    const last = state.status?.lastScan;
    if (job?.kind === 'scan') {
        put(holder, h('span', { text: job.log?.at(-1) || 'Проверка началась' }), h('span', { class: 'mono', text: 'идёт' }));
    } else if (last) {
        const parts = [`${last.chats} ${plural(last.chats, 'чат', 'чата', 'чатов')}`];
        if (last.modelUsed) parts.push(`модель: ${last.modelCalls} ${plural(last.modelCalls, 'запрос', 'запроса', 'запросов')}`);
        else parts.push('без модели');
        put(holder, h('span', { text: `Проверено ${when(last.at)}` }), h('span', { class: 'mono', text: parts.join(' · ') }));
    } else {
        put(holder, h('span', { text: 'Проверок ещё не было' }));
    }
}

function relatedChats(p) {
    return new Set([...(p.chats || []), p.target?.chatId].filter(Boolean));
}

function chatTitle(id) {
    const chat = state.chats.find(c => c.id === id);
    if (chat) return chat.title + (chat.isGroup ? '' : ` · ${chat.file}`);
    const p = state.proposals.find(x => x.target?.chatId === id);
    return p?.target?.label || id.split('/').pop();
}

function matchesChatFilter(p) {
    if (state.feedChat === 'all') return true;
    const related = relatedChats(p);
    if (state.feedChat === 'watched') {
        const watched = state.chats.filter(c => c.watched).map(c => c.id);
        return watched.some(id => related.has(id));
    }
    return related.has(state.feedChat);
}

function renderFeed() {
    const view = $('#view');
    const all = sortedFeed();
    const items = all.filter(matchesChatFilter);
    const counts = { all: items.length, chats: 0, tokens: 0, lore: 0, cards: 0 };
    for (const p of items) counts[proposalGroup(p)]++;
    const visible = state.filter === 'all' ? items : items.filter(p => proposalGroup(p) === state.filter);

    // Which chats to show: all, the marked ones, or one chat.
    const chatIds = [...new Set(all.flatMap(p => [...relatedChats(p)]))];
    const hasWatched = state.chats.some(c => c.watched);
    if (!['all', 'watched'].includes(state.feedChat) && !chatIds.includes(state.feedChat)) chatIds.push(state.feedChat);
    const chatSelect = h('select', { class: 'select', 'aria-label': 'Какие чаты показывать', style: 'width:100%' },
        h('option', { value: 'all', text: 'Все чаты' }),
        hasWatched ? h('option', { value: 'watched', text: 'Только отмеченные чаты' }) : null,
        chatIds.sort((a, b) => chatTitle(a).localeCompare(chatTitle(b))).map(id => h('option', { value: id, text: chatTitle(id) })));
    chatSelect.value = state.feedChat === 'watched' && !hasWatched ? 'all' : state.feedChat;
    chatSelect.addEventListener('change', () => {
        state.feedChat = chatSelect.value;
        storageSet('korrektor.feedChat', state.feedChat);
        renderFeed();
    });

    const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Фильтр' },
        [['all', 'Все'], ['chats', 'Чаты'], ['tokens', 'Токены'], ['lore', 'Лорбуки'], ['cards', 'Карточки']].map(([key, label]) =>
            h('button', {
                class: 'filter', type: 'button', 'aria-pressed': String(state.filter === key),
                onclick: () => { state.filter = key; renderFeed(); },
            }, label, h('span', { class: 'mono', text: counts[key] }))));

    if (remarksOff()) {
        // What was asked for still shows; findings do not.
        put(view,
            h('div', { class: 'empty' },
                tools.mascot('sleep', 150),
                h('h2', { text: 'Замечания выключены' }),
                h('p', { text: 'Корректор не проверяет чаты, лорбуки и карточки и не присылает находки. Перевод, каталог, расходы, резервные копии и «Попросить Корректора» работают' }),
                h('p', {}, h('button', { class: 'btn secondary', type: 'button', style: 'margin-top:16px', onclick: () => setRemarks(true), text: 'Включить замечания' }))),
            all.length ? h('div', { class: 'list' }, all.map(renderCard)) : null);
        return;
    }
    const single = !['all', 'watched'].includes(state.feedChat);
    const children = [
        h('p', { class: 'scanline', id: 'scanline' }),
        h('div', { class: 'chat-filter' }, chatSelect),
        single ? h('a', { class: 'btn secondary small', href: `#chat/${encodeURIComponent(state.feedChat)}`, style: 'margin:0 0 12px', text: 'Попросить Корректора об этом чате' }) : null,
        filters,
    ].filter(Boolean);
    if (!visible.length) {
        const filtered = all.length && !items.length;
        const scanning = state.job?.kind === 'scan';
        children.push(h('div', { class: 'empty' },
            tools.mascot(scanning ? 'write' : 'sleep', 150),
            h('h2', { text: scanning ? 'Проверяю чаты' : filtered ? 'В выбранных чатах замечаний нет' : items.length ? 'В этом разделе пусто' : 'Замечаний нет' }),
            h('p', { text: filtered ? 'Выберите другие чаты в списке выше' : items.length ? 'Загляните в другие разделы' : 'Корректор проверяет чаты сам. Можно запустить проверку вручную кнопкой вверху' }),
            !all.length ? h('p', {}, h('button', { class: 'btn secondary', type: 'button', style: 'margin-top:16px', onclick: () => startScan(), text: 'Проверить сейчас' })) : null));
    } else {
        children.push(h('div', { class: 'list' }, visible.map(renderCard)));
    }
    // Not wanted at all: one switch.
    children.push(h('p', { class: 'feed-off' }, h('button', { class: 'btn quiet small', type: 'button', onclick: () => setRemarks(false), text: 'Выключить замечания' })));
    put(view, ...children);
    renderScanline();
}

function cardMeta(p) {
    return h('div', { class: 'card-meta' },
        h('span', { class: `dot ${p.severity}`, 'aria-hidden': 'true' }),
        h('span', { text: KIND[p.kind] ?? p.kind }),
        h('span', { text: '·' }),
        h('span', { class: 'target', text: p.target?.label || p.target?.world || p.target?.avatar || '' }));
}

function renderQuote(item) {
    return h('div', { class: 'quote' },
        h('span', { class: 'quote-no', text: Number.isInteger(item.index) ? `#${item.index}` : '' }),
        item.label && !String(item.label).startsWith('#') ? h('span', { class: 'quote-label', text: item.label }) : null,
        h('p', { class: 'quote-text', text: item.text }));
}

function renderCard(p) {
    const dim = p.status === 'stale' || p.status === 'failed';
    const actions = [];
    if (p.advice && p.status === 'open') {
        actions.push(h('button', { class: 'btn secondary small', type: 'button', onclick: () => reject(p), text: 'Понятно' }));
        const first = p.evidence?.find(e => e.text);
        return h('article', { class: 'card' },
            cardMeta(p),
            h('h2', { class: 'card-title' }, h('a', { href: `#p/${encodeURIComponent(p.id)}`, style: 'text-decoration:none', text: p.title })),
            h('p', { class: 'card-summary', text: p.summary }),
            first ? renderQuote(first) : null,
            h('div', { class: 'card-actions' }, actions));
    }
    if (p.status === 'open') {
        actions.push(
            h('button', { class: 'btn primary small', type: 'button', onclick: (e) => { e.stopPropagation(); applyProposal(p); }, text: 'Применить' }),
            h('a', { class: 'btn secondary small', href: `#p/${encodeURIComponent(p.id)}`, text: 'Разница' }));
    } else if (p.status === 'needs_fix') {
        actions.push(h('button', { class: 'btn primary small', type: 'button', onclick: () => prepare(p), text: 'Подготовить правку' }));
    } else if (p.status === 'preparing') {
        actions.push(h('button', { class: 'btn secondary small', type: 'button', disabled: true, text: 'Модель пишет правку' }));
    } else if (p.status === 'failed') {
        actions.push(h('button', { class: 'btn secondary small', type: 'button', onclick: () => prepare(p), text: 'Повторить' }));
    } else if (p.status === 'stale') {
        actions.push(h('button', { class: 'btn secondary small', type: 'button', onclick: () => startScan(p.target?.chatId ? [p.target.chatId] : null), text: 'Проверить снова' }));
    }
    actions.push(h('span', { class: 'spacer' }),
        h('button', { class: 'btn quiet small', type: 'button', onclick: () => reject(p), text: dim ? 'Убрать' : 'Отклонить' }));

    const first = p.evidence?.find(e => e.text);
    return h('article', { class: `card${dim ? ' dim' : ''}` },
        cardMeta(p),
        h('h2', { class: 'card-title' }, h('a', { href: `#p/${encodeURIComponent(p.id)}`, style: 'text-decoration:none', text: p.title })),
        h('p', { class: 'card-summary clamp', text: p.summary }),
        first ? renderQuote(first) : null,
        p.error ? h('p', { class: 'card-error', text: p.error }) : null,
        h('div', { class: 'card-actions' }, actions));
}

async function applyProposal(p) {
    try {
        const result = await api(`/proposals/${p.id}/apply`, { method: 'POST', body: { overrides: state.overrides[p.id] } });
        delete state.overrides[p.id];
        toast(result.edited ? 'Применено с вашими правками, копия сохранена' : 'Применено, копия сохранена');
    } catch (error) {
        toast(error.message, true);
    }
    await Promise.allSettled([loadProposals(), loadStatus()]);
    if (currentRoute().name === 'proposal') location.hash = '#feed';
    else renderRoute();
}

async function reject(p) {
    let result = null;
    try {
        result = await api(`/proposals/${p.id}/reject`, { method: 'POST' });
    } catch (error) {
        toast(error.message, true);
    }
    await loadProposals();
    if (currentRoute().name === 'proposal') location.hash = '#feed';
    else renderRoute();
    await tools.offerMute(result);
}

async function prepare(p) {
    try {
        const job = await api(`/proposals/${p.id}/prepare`, { method: 'POST' });
        await loadProposals();
        renderRoute();
        followJob(job);
    } catch (error) {
        toast(error.message, true);
    }
}

async function followup(p, index) {
    try {
        const { proposal, job } = await api(`/proposals/${p.id}/followup`, { method: 'POST', body: { index } });
        await loadProposals();
        location.hash = `#p/${encodeURIComponent(proposal.id)}`;
        followJob(job);
    } catch (error) {
        toast(error.message, true);
    }
}

// ---------- proposal detail ----------

function openSheet(metaText, body, foot) {
    // Loaded after the person already went back: do not pop up over the page they are on now.
    if (openSheet.hash !== undefined && location.hash !== openSheet.hash) return;
    const sheet = $('#sheet');
    const back = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Назад', onclick: () => history.length > 1 ? history.back() : (location.hash = '#feed') }, icon('back'));
    put(sheet, 
        h('div', { class: 'sheet-head' }, back, h('span', { class: 'meta', text: metaText })),
        h('div', { class: 'sheet-body' }, body),
        foot ? h('div', { class: 'sheet-foot' }, foot) : null);
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
}

function renderProse(text, mode, before, after, key) {
    if (mode === 'diff') {
        const parts = diffWords(before ?? '', after ?? '');
        const long = (after ?? '').length + (before ?? '').length > 2400;
        const collapsed = long && !state.expanded[key];
        const prose = h('p', { class: `prose${collapsed ? ' collapsed' : ''}` },
            parts.map(([type, value]) => type === 0 ? value : h(type > 0 ? 'ins' : 'del', { text: value })));
        return [prose, long ? h('button', {
            class: 'btn quiet small expand', type: 'button',
            onclick: () => { state.expanded[key] = !state.expanded[key]; renderRoute(); },
            text: collapsed ? 'Показать целиком' : 'Свернуть',
        }) : null];
    }
    return [h('p', { class: 'prose', text: text || '—' })];
}

function renderKeys(before = [], after = []) {
    const lower = (list) => new Set(list.map(k => String(k).toLowerCase()));
    const b = lower(before);
    const a = lower(after);
    const items = [
        ...after.map(k => ({ k, cls: b.has(String(k).toLowerCase()) ? '' : 'added' })),
        ...before.filter(k => !a.has(String(k).toLowerCase())).map(k => ({ k, cls: 'removed' })),
    ];
    return h('div', { class: 'keys' }, items.map(({ k, cls }) => h('span', { class: `key ${cls}`, text: k })));
}

function renderChange(p, view, index) {
    const key = `${p.id}:${index}`;
    const hasText = typeof view.after === 'string' || typeof view.before === 'string';
    const editable = view.editable && p.status === 'open';
    const override = state.overrides[p.id]?.[index];
    const after = typeof override === 'string' ? override : view.after;
    const isNew = !view.before && after;
    const mode = state.modes[key] || (isNew ? 'after' : 'diff');

    const modes = hasText && !isNew ? [['diff', 'Разница'], ['before', 'Было'], ['after', 'Станет']] : [];
    if (editable) modes.push(['edit', 'Править']);
    const head = h('div', { class: 'change-head' },
        h('span', { class: 'change-label', text: view.label }),
        modes.length > 1 || editable ? h('div', { class: 'modes', role: 'group' }, modes.map(([m, label]) =>
            h('button', {
                class: 'mode', type: 'button', 'aria-pressed': String(mode === m),
                onclick: () => { state.modes[key] = m; renderRoute(); },
            }, label))) : null);

    const body = [];
    if (view.keys) {
        body.push(h('div', { style: hasText ? 'margin-bottom:12px' : '' }, h('span', { class: 'quote-label', text: 'Ключи' }), renderKeys(view.keysBefore ?? [], view.keys)));
    }
    if (hasText) {
        if (mode === 'edit') {
            const area = h('textarea', { class: 'editor', 'aria-label': 'Новый текст' });
            area.value = after ?? '';
            area.addEventListener('input', () => {
                state.overrides[p.id] = { ...(state.overrides[p.id] || {}), [index]: area.value };
            });
            body.push(area, h('p', { class: 'small muted', style: 'margin:8px 0 0', text: 'Ваш вариант будет применён вместо предложенного' }));
        } else {
            body.push(...renderProse(mode === 'before' ? view.before : after, mode, view.before, after, key));
        }
    }
    return h('section', { class: 'change' },
        head,
        body.length ? h('div', { class: 'change-body' }, body) : null,
        view.note ? h('p', { class: 'change-note', text: view.note }) : null);
}

async function renderProposalSheet(id) {
    let p = state.proposals.find(x => x.id === id) || state.history.find(x => x.id === id);
    try {
        p = await api(`/proposals/${encodeURIComponent(id)}`);
    } catch (error) {
        if (!p) {
            openSheet('', h('div', { class: 'empty' }, h('h2', { text: 'Карточка не найдена' }), h('p', { text: error.message })));
            return;
        }
    }

    const body = [
        cardMeta(p),
        h('h1', { class: 'sheet-title', text: p.title }),
        h('p', { class: 'card-summary', text: p.summary }),
        (p.evidence || []).map(renderQuote),
    ];

    if (p.status === 'preparing' || (state.job?.kind === 'prepare' && state.job.meta?.id === p.id)) {
        body.push(h('section', { class: 'change' }, h('div', { class: 'change-body' },
            h('p', { class: 'secondary', style: 'margin:0', text: 'Модель пишет правку. Обычно это занимает до минуты' }))));
    } else if (p.views?.length) {
        body.push(p.views.map((view, i) => renderChange(p, view, i)));
    } else if (p.status === 'needs_fix' || p.status === 'failed') {
        body.push(h('section', { class: 'change' }, h('div', { class: 'change-body' },
            h('p', { class: 'secondary', style: 'margin:0', text: 'Правку напишет модель, когда вы попросите. Перед применением вы увидите разницу' }))));
    }

    if (p.note) body.push(h('p', { class: 'small secondary', style: 'margin:12px 0 0', text: p.note }));
    if (p.error) body.push(h('p', { class: 'card-error', text: p.error }));
    if (p.status === 'open' && p.ops?.some(op => op.op?.startsWith('chat.'))) {
        body.push(h('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'Открытый в SillyTavern чат обновится сам через пару секунд, если стоит расширение «Корректор: синхронизация». Без него обновите страницу SillyTavern вручную' }));
    }

    if (p.followups?.length && ['open', 'applied', 'rejected'].includes(p.status)) {
        body.push(h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'Ещё можно' }),
            p.followups.map((f, i) => h('button', { class: 'btn secondary block', type: 'button', style: 'margin-top:8px', onclick: () => followup(p, i), text: f.label }))));
    }

    const facts = [['Статус', STATUS_TEXT[p.status] ?? p.status], ['Найдено', when(p.createdAt)]];
    if (p.model) facts.push(['Модель', p.model]);
    if (p.appliedAt) facts.push(['Применено', when(p.appliedAt)]);
    if (p.backupId) facts.push(['Копия', p.backupId]);
    body.push(h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', { text: k }), h('dd', { class: k === 'Копия' || k === 'Модель' ? 'mono' : '', text: v })])));

    let foot = null;
    if (p.advice && p.status === 'open') {
        foot = [h('button', { class: 'btn secondary', type: 'button', onclick: () => reject(p), text: 'Понятно, скрыть' })];
    } else if (p.status === 'open') {
        foot = [h('button', { class: 'btn secondary', type: 'button', onclick: () => reject(p), text: 'Отклонить' }),
            h('button', { class: 'btn primary', type: 'button', onclick: () => applyProposal(p), text: state.overrides[p.id] ? 'Применить с правками' : 'Применить' })];
    } else if (p.status === 'needs_fix' || p.status === 'failed') {
        foot = [h('button', { class: 'btn secondary', type: 'button', onclick: () => reject(p), text: 'Отклонить' }),
            h('button', { class: 'btn primary', type: 'button', onclick: () => prepare(p), text: p.status === 'failed' ? 'Повторить' : 'Подготовить правку' })];
    } else if (p.status === 'applied') {
        foot = [h('button', { class: 'btn secondary', type: 'button', onclick: () => revert(p), text: 'Откатить' })];
    } else if (p.status === 'stale') {
        foot = [h('button', { class: 'btn secondary', type: 'button', onclick: () => reject(p), text: 'Убрать' }),
            h('button', { class: 'btn primary', type: 'button', onclick: () => { location.hash = '#feed'; startScan(p.target?.chatId ? [p.target.chatId] : null); }, text: 'Проверить снова' })];
    }
    openSheet(`${KIND[p.kind] ?? ''} · ${p.target?.label ?? ''}`, body, foot);
}

async function revert(p) {
    const ok = await confirmDialog({ title: 'Откатить изменение', text: 'Будет возвращено то, что было до применения. Остальные изменения в файле сохранятся', ok: 'Откатить' });
    if (!ok) return;
    try {
        await api(`/proposals/${p.id}/revert`, { method: 'POST', body: {} });
        toast('Откачено');
    } catch (error) {
        if (error.canForce) {
            const force = await confirmDialog({
                title: 'Точный откат невозможен',
                text: `${error.message}`,
                ok: 'Восстановить файлы целиком',
                danger: true,
            });
            if (force) {
                try {
                    await api(`/proposals/${p.id}/revert`, { method: 'POST', body: { force: true } });
                    toast('Файлы восстановлены из копии. Текущее состояние тоже сохранено в копию');
                } catch (e) {
                    toast(e.message, true);
                }
            }
        } else {
            toast(error.message, true);
        }
    }
    await Promise.allSettled([loadHistory(), loadProposals()]);
    renderRoute();
}

// ---------- chats ----------

const STAR = '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>';

function starButton(chat, onchange) {
    const btn = h('button', {
        class: `icon-button star${chat.watched ? ' on' : ''}`, type: 'button',
        'aria-pressed': String(Boolean(chat.watched)),
        'aria-label': chat.watched ? 'Не отслеживать чат' : 'Отслеживать чат',
    });
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAR}</svg>`;
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !chat.watched;
        try {
            await api('/watch', { method: 'POST', body: { chatId: chat.id, watched: next } });
            chat.watched = next;
            for (const c of state.chats) if (c.id === chat.id) c.watched = next;
            onchange?.();
        } catch (error) {
            toast(error.message, true);
        }
    });
    return btn;
}

async function loadChats() {
    const data = await api('/chats');
    state.chats = data.items;
    state.scanMode = data.mode;
    return state.chats;
}

async function renderChats() {
    const view = $('#view');
    if (!state.chats.length) put(view, h('p', { class: 'muted', text: 'Загружаю чаты' }));
    try {
        await loadChats();
    } catch (error) {
        put(view, h('div', { class: 'empty' }, h('h2', { text: 'Не удалось загрузить чаты' }), h('p', { text: error.message })));
        return;
    }
    if (!state.chats.length) {
        put(view, h('div', { class: 'empty' }, h('h2', { text: 'Чатов пока нет' }), h('p', { text: 'Начните чат в SillyTavern, и он появится здесь' })));
        return;
    }

    const search = h('input', { class: 'input', type: 'search', placeholder: 'Найти чат', value: state.chatQuery, 'aria-label': 'Найти чат', style: 'width:100%' });
    const list = h('div');
    const watchedCount = () => state.chats.filter(c => c.watched).length;
    const tabs = h('div', { class: 'filters', role: 'group' });
    const hint = h('p', { class: 'small muted', style: 'margin:0 0 12px' });

    const draw = () => {
        const q = state.chatQuery.trim().toLowerCase();
        const pool = state.chatsView === 'watched' ? state.chats.filter(c => c.watched) : state.chats;
        const found = q ? pool.filter(c => `${c.title} ${c.file}`.toLowerCase().includes(q)) : pool;
        put(tabs, ...[['all', 'Все', state.chats.length], ['watched', 'Отмеченные', watchedCount()]].map(([key, label, n]) =>
            h('button', { class: 'filter', type: 'button', 'aria-pressed': String(state.chatsView === key), onclick: () => { state.chatsView = key; draw(); } },
                label, h('span', { class: 'mono', text: n }))));
        hint.textContent = state.scanMode === 'watched'
            ? 'Корректор сам проверяет только отмеченные чаты. Звёздочка — отметить'
            : 'Сейчас Корректор сам проверяет последние изменённые чаты. Отметьте звёздочкой нужные и включите в настройках «Только отмеченные»';
        const shown = found.slice(0, 100);
        put(list, ...[
            shown.length ? h('div', { class: 'rows' }, shown.map(chat => h('div', { class: 'row chat-row' },
                starButton(chat, draw),
                h('a', { class: 'row-link', href: `#chat/${encodeURIComponent(chat.id)}` },
                    h('span', { class: 'row-main' },
                        h('span', { class: 'row-title', text: chat.title }),
                        h('span', { class: 'row-sub', text: `${chat.isGroup ? 'группа · ' : ''}${chat.file} · ${when(new Date(chat.mtime).toISOString())}` })),
                    chat.open ? h('span', { class: 'row-side accent', text: `${chat.open} ${plural(chat.open, 'замечание', 'замечания', 'замечаний')}` }) : h('span', { class: 'row-side', text: chat.scannedAt ? 'проверен' : '' }),
                    h('span', { class: 'chev' }, icon('chev'))))))
                : h('div', { class: 'empty' }, h('p', { text: state.chatsView === 'watched' && !q ? 'Отмеченных чатов пока нет. Нажмите звёздочку у нужного чата' : 'Ничего не нашлось' })),
            found.length > shown.length ? h('p', { class: 'small muted', style: 'margin:12px 0 0', text: `Показано ${shown.length} из ${found.length}. Уточните поиск` }) : null,
        ].filter(Boolean));
    };
    search.addEventListener('input', () => { state.chatQuery = search.value; draw(); });
    draw();
    put(view, h('div', { style: 'margin-bottom:12px' }, search), tabs, hint, list);
}

// ---------- "Ask Korrektor" ----------

function renderAsk(chatId) {
    const st = state.ask[chatId] ||= { text: '', job: null, result: null, error: null };
    const area = h('textarea', {
        class: 'editor', rows: 3, style: 'min-height:96px',
        placeholder: 'Например: добавь в лорбук запись про таверну «Сломанный рог»; перепиши #124 без штампов; что известно про Бориса?',
        'aria-label': 'Просьба к Корректору',
    });
    area.value = st.text;
    area.addEventListener('input', () => { st.text = area.value; });
    const running = st.job?.status === 'running';
    const send = h('button', { class: 'btn primary small', type: 'button', disabled: running, text: running ? 'Корректор думает' : 'Отправить' });
    const out = h('div', { class: 'ask-out' });

    const paint = async () => {
        const items = [];
        if (st.job?.status === 'running') {
            items.push(h('p', { class: 'small secondary', style: 'margin:8px 0 0', text: st.job.log?.at(-1) || 'Читаю чат' }));
        }
        if (st.error) items.push(h('p', { class: 'card-error', text: st.error }));
        if (st.result) {
            const card = st.result.proposalId ? (state.proposals.find(x => x.id === st.result.proposalId) || await api(`/proposals/${st.result.proposalId}`).catch(() => null)) : null;
            // The card already carries the answer as its text: do not print it twice.
            if (!card || card.summary !== st.result.answer) items.push(h('p', { class: 'prose', style: 'margin:12px 0 0', text: st.result.answer }));
            if (st.result.skipped?.length) items.push(h('p', { class: 'small muted', style: 'margin:4px 0 0', text: `Пропущено: ${st.result.skipped.join(', ')}` }));
            if (card) items.push(h('div', { class: 'list', style: 'margin-top:12px' }, renderCard(card)));
        }
        put(out, ...items);
    };

    send.addEventListener('click', async () => {
        if (!st.text.trim()) return area.focus();
        st.error = null;
        st.result = null;
        try {
            st.job = await api('/ask', { method: 'POST', body: { chatId, request: st.text } });
        } catch (error) {
            st.error = error.message;
            paint();
            return;
        }
        send.disabled = true;
        send.textContent = 'Корректор думает';
        paint();
        while (st.job?.status === 'running') {
            await new Promise(r => setTimeout(r, 1000));
            try {
                st.job = await api(`/jobs/${st.job.id}`);
            } catch {
                break;
            }
            paint();
        }
        if (st.job?.status === 'error') st.error = st.job.error;
        if (st.job?.status === 'done') {
            st.result = st.job.result;
            st.text = '';
            area.value = '';
            await loadProposals();
        }
        send.disabled = false;
        send.textContent = 'Отправить';
        paint();
    });

    paint();
    return h('div', { class: 'section' },
        h('h3', { class: 'section-title', text: 'Попросить Корректора' }),
        area,
        h('div', { class: 'field-row', style: 'margin-top:8px' },
            h('span', { class: 'small muted', text: 'Правки придут карточкой: вы увидите разницу и решите сами' }),
            send),
        out);
}

const GROUP_STYLE = {
    history: ['var(--accent)', 'История чата'],
    preset: ['var(--text)', 'Пресет и системный промпт'],
    card: ['var(--text-2)', 'Карточка'],
    lore: ['var(--text-3)', 'Лорбуки'],
    memory: ['var(--line-strong)', 'Память и заметки'],
    persona: ['var(--line-strong)', 'Персона'],
};

async function renderChatSheet(id) {
    openSheet('Чат', h('p', { class: 'muted', text: 'Считаю, из чего состоит контекст' }));
    let info;
    try {
        info = await api(`/chat?id=${encodeURIComponent(id)}`);
    } catch (error) {
        openSheet('Чат', h('div', { class: 'empty' }, h('h2', { text: 'Не удалось открыть чат' }), h('p', { text: error.message })));
        return;
    }
    const u = info.usage;
    const total = Math.max(u.total, u.budget, 1);
    const groups = new Map();
    for (const item of u.items) groups.set(item.group, (groups.get(item.group) || 0) + item.tokens);
    const order = ['history', 'preset', 'card', 'lore', 'memory', 'persona'].filter(g => groups.get(g));
    const related = state.proposals.filter(p => relatedChats(p).has(info.id));
    const chat = state.chats.find(c => c.id === info.id) || { id: info.id, watched: info.watched };
    const reasonText = { constant: 'постоянная', key: 'по ключу', recursion: 'по цепочке' };

    const a = info.actual;
    const actualSection = a && a.total ? h('div', { class: 'section' },
        h('h3', { class: 'section-title', text: 'Последний ответ: точно, как посчитал SillyTavern' }),
        h('div', {}, h('span', { class: 'big', text: fmt(a.total) }), h('span', { class: 'secondary', text: a.maxContext ? ` из ${fmt(a.maxContext)} токенов` : ' токенов' })),
        h('p', { class: 'small muted', style: 'margin:4px 0 8px', text: [a.model, a.tokenizer && `токенизатор ${a.tokenizer}`, when(a.at)].filter(Boolean).join(' · ') }),
        h('div', { class: 'rows' }, a.items.map(item => h('div', { class: 'row' },
            h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: item.label })),
            h('span', { class: 'row-side', text: fmt(item.tokens) })))),
        a.extensions?.length ? h('div', { style: 'margin-top:12px' },
            h('span', { class: 'quote-label', text: 'Вставки расширений' }),
            h('div', { class: 'rows' }, a.extensions.slice().sort((x, y) => y.tokens - x.tokens).map(x => h('div', { class: 'row' },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: x.name }), x.preview ? h('span', { class: 'row-sub', text: x.preview }) : null),
                h('span', { class: 'row-side', text: fmt(x.tokens) }))))) : null,
        a.worldInfo?.length ? h('p', { class: 'small secondary', style: 'margin:8px 0 0', text: `Сработали записи лорбука: ${a.worldInfo.map(x => x.label).filter(Boolean).slice(0, 12).join(', ')}` }) : null)
        : h('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'Точные цифры появятся после следующего ответа в этом чате, если в SillyTavern стоит расширение «Корректор: синхронизация». Ниже — оценка по файлам' });

    const body = [
        h('div', { class: 'field-row', style: 'align-items:flex-start' },
            h('h1', { class: 'sheet-title', text: info.title }),
            starButton(chat, () => renderChatSheet(id))),
        h('p', { class: 'small muted', style: 'margin:0', text: `${info.messages} ${plural(info.messages, 'сообщение', 'сообщения', 'сообщений')}, скрыто из контекста ${u.hiddenCount}${u.preset ? ` · пресет «${u.preset}»` : ''}` }),
        h('div', { class: 'card-actions' },
            tools.compressButton(info),
            info.id.startsWith('c/') ? h('a', { class: 'btn secondary small', href: `#card/${encodeURIComponent(`${info.id.split('/')[1]}.png`)}`, text: 'Здоровье карточки' }) : null),
        tools.recapSection(info),
        renderAsk(info.id),
        actualSection,
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: a && a.total ? 'Оценка по файлам, если отправить сейчас' : 'Контекст' }),
            u.budget
                ? h('div', {}, h('span', { class: 'big', text: `${Math.round(u.ratio * 100)}%` }), h('span', { class: 'secondary', text: ` ≈${fmt(u.total)} из ${fmt(u.budget)} токенов` }))
                : h('p', { class: 'secondary', style: 'margin:0', text: `≈${fmt(u.total)} токенов. Размер контекста не задан в SillyTavern` }),
            h('div', { class: 'bar', role: 'img', 'aria-label': 'Из чего состоит контекст' },
                order.map(g => h('span', { style: `width:${(groups.get(g) / total) * 100}%;background:${GROUP_STYLE[g][0]}` }))),
            h('div', { class: 'legend' }, order.map(g => legendRow(GROUP_STYLE[g][0], GROUP_STYLE[g][1], groups.get(g)))),
            u.budget && u.ratio > 1 ? h('p', { class: 'small secondary', style: 'margin:8px 0 0', text: `Всё сразу не влезает: SillyTavern отправляет модели только последние сообщения, а ≈${fmt(u.total - u.budget)} токенов самого начала чата она уже не видит` }) : null),
        h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'Что больше всего занимает' }),
            h('div', { class: 'rows' }, u.items.slice(0, 12).map(item => h('div', { class: 'row' },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: item.label })),
                h('span', { class: 'row-side', text: `≈${fmt(item.tokens)}` }))))),
        u.wi.included.length || u.wi.dropped.length ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: `Лорбук в запросе: ${u.wi.included.length} ${plural(u.wi.included.length, 'запись', 'записи', 'записей')}, ≈${fmt(u.wi.tokens)} токенов${u.wi.budget ? ` из ${fmt(u.wi.budget)}` : ''}` }),
            h('div', { class: 'rows' }, u.wi.included.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 10).map(x => h('div', { class: 'row' },
                h('span', { class: 'row-main' }, h('span', { class: 'row-title', text: x.label }), h('span', { class: 'row-sub', text: `${x.world} · ${reasonText[x.reason] ?? x.reason}` })),
                h('span', { class: 'row-side', text: `≈${fmt(x.tokens)}` })))),
            u.wi.dropped.some(x => x.why === 'budget')
                ? h('p', { class: 'small', style: 'margin:8px 0 0;color:var(--del-text)', text: `Не влезли в бюджет лорбука: ${u.wi.dropped.filter(x => x.why === 'budget').map(x => x.label).join(', ')}` })
                : null) : null,
        h('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'Оценка приблизительная: токены считаются без токенизатора модели. Записи лорбука — те, что сработали бы на последнем сообщении, с бюджетом и цепочками, как в SillyTavern' }),
        info.charMemory ? h('div', { class: 'section' },
            h('h3', { class: 'section-title', text: 'CharMemory' }),
            h('p', { class: 'secondary', style: 'margin:0', text: !info.charMemory.enabled
                ? 'Расширение установлено, но выключено'
                : info.charMemory.files.length
                    ? `${info.charMemory.count} ${plural(info.charMemory.count, 'воспоминание', 'воспоминания', 'воспоминаний')} в ${info.charMemory.files.join(', ')}${info.charMemory.retrieval ? '' : '. Векторная память для файлов выключена: модель их не получает'}`
                    : 'Воспоминаний у этого персонажа пока нет' })) : null,
        info.note.prompt ? h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'Заметка автора' }), h('p', { class: 'prose', text: info.note.prompt })) : null,
        info.summary ? h('div', { class: 'section' }, h('h3', { class: 'section-title', text: `Резюме (в сообщении #${info.summary.index})` }), h('p', { class: 'prose', text: info.summary.text })) : null,
        related.length ? h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'Замечания' }), h('div', { class: 'list' }, related.map(renderCard))) : null,
    ];
    openSheet(info.id, body, [h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => { location.hash = '#feed'; startScan([info.id]); },
        text: 'Проверить этот чат',
    })]);
}

function legendRow(color, label, value) {
    return [h('i', { style: `background:${color}` }), h('span', { text: label }), h('span', { class: 'mono', text: `≈${fmt(value)}` })];
}

// ---------- history ----------

async function renderHistory() {
    const view = $('#view');
    const tabs = h('div', { class: 'filters', role: 'group' },
        [['changes', 'Изменения'], ['backups', 'Резервные копии']].map(([key, label]) =>
            h('button', { class: 'filter', type: 'button', 'aria-pressed': String(state.historyTab === key), onclick: () => { state.historyTab = key; renderHistory(); } }, label)));
    try {
        if (state.historyTab === 'changes') await loadHistory();
        else state.backups = (await api('/backups')).items;
    } catch (error) {
        put(view, tabs, h('div', { class: 'empty' }, h('h2', { text: 'Не удалось загрузить' }), h('p', { text: error.message })));
        return;
    }

    if (state.historyTab === 'changes') {
        if (!state.history.length) {
            put(view, tabs, h('div', { class: 'empty' }, h('h2', { text: 'Изменений пока нет' }), h('p', { text: 'Здесь будут применённые и отклонённые предложения. Применённые можно откатить' })));
            return;
        }
        put(view, tabs, h('div', { class: 'rows' }, state.history.map(p =>
            h('a', { class: 'row', href: `#p/${encodeURIComponent(p.id)}` },
                h('span', { class: 'row-main' },
                    h('span', { class: 'row-title', text: p.title }),
                    h('span', { class: 'row-sub', text: `${p.target?.label ?? ''} · ${when(p.appliedAt || p.revertedAt || p.rejectedAt || p.updatedAt)}` })),
                h('span', { class: `status-tag ${p.status}`, text: STATUS_TEXT[p.status] }),
                h('span', { class: 'chev' }, icon('chev'))))));
        return;
    }

    if (!state.backups.length) {
        put(view, tabs, h('div', { class: 'empty' }, h('h2', { text: 'Копий пока нет' }), h('p', { text: 'Перед каждым изменением файл копируется в data/<пользователь>/korrektor/backups' })));
        return;
    }
    put(view, tabs,
        h('p', { class: 'small muted', style: 'margin:0 0 12px', text: 'Хранятся последние 100 копий. Восстановление возвращает файлы целиком, текущее состояние при этом тоже сохраняется' }),
        h('div', { class: 'rows' }, state.backups.map(b =>
            h('div', { class: 'row' },
                h('span', { class: 'row-main' },
                    h('span', { class: 'row-title', text: b.title || 'Изменение' }),
                    h('span', { class: 'row-sub', text: `${when(b.createdAt)} · ${b.files.map(f => f.path).join(', ')}` })),
                h('button', { class: 'btn quiet small', type: 'button', onclick: () => restore(b), text: 'Восстановить' })))));
}

async function restore(backup) {
    const ok = await confirmDialog({
        title: 'Восстановить из копии',
        text: `Файлы вернутся к состоянию на ${when(backup.createdAt)}. Всё, что менялось в них позже, пропадёт, но текущее состояние тоже сохранится в копию`,
        ok: 'Восстановить',
        danger: true,
    });
    if (!ok) return;
    try {
        await api(`/backups/${encodeURIComponent(backup.id)}/restore`, { method: 'POST' });
        toast('Файлы восстановлены');
    } catch (error) {
        toast(error.message, true);
    }
    renderHistory();
}

// ---------- settings ----------

function sw(checked, onchange, label) {
    const input = h('input', { type: 'checkbox', 'aria-label': label });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onchange(input.checked));
    return h('span', { class: 'switch' }, input, h('span'));
}

function seg(options, value, onchange) {
    return h('div', { class: 'seg', role: 'group' }, options.map(([v, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(value === v), onclick: () => onchange(v) }, label)));
}

async function fillModels(source, datalist) {
    if (!state.modelLists[source]) {
        try {
            state.modelLists[source] = (await api(`/models?source=${encodeURIComponent(source)}`)).items;
        } catch {
            state.modelLists[source] = [];
        }
    }
    put(datalist, ...state.modelLists[source].map(id => h('option', { value: id })));
}

let saveTimer = null;
function save(patch, rerender = false) {
    clearTimeout(saveTimer);
    state.pending = deepMerge(state.pending || {}, patch);
    state.settings = deepMerge(state.settings, patch);
    if (rerender) renderSettings(false);
    saveTimer = setTimeout(async () => {
        const body = state.pending;
        state.pending = null;
        try {
            state.settings = await api('/settings', { method: 'POST', body });
            await loadStatus();
            if (rerender && currentRoute().name === 'settings') renderSettings(false);
        } catch (error) {
            toast(error.message, true);
        }
    }, 400);
}

function deepMerge(base, patch) {
    const out = structuredClone(base || {});
    for (const [k, v] of Object.entries(patch || {})) {
        out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
    }
    return out;
}

/**
 * The translator's own key: whose, the key, the model, «Проверить и сохранить». The key is kept by
 * the plugin and never comes back here — only its last four characters.
 */
function translateKeyBlock() {
    const box = h('div', { class: 'field' }, h('span', { class: 'label', text: 'Свой ключ для перевода' }), h('span', { class: 'hint', text: 'Загружаю…' }));
    api('/translate/key').then((cfg) => {
        const provider = h('select', { class: 'select', 'aria-label': 'Чей ключ', style: 'flex:1;min-width:0' },
            (cfg.providers || []).map(p => h('option', { value: p.id, text: p.label })));
        provider.value = cfg.provider || 'openrouter';
        const url = h('input', { class: 'input mono', type: 'url', value: cfg.provider === 'custom' ? cfg.url || '' : '', placeholder: 'https://адрес-сервера/v1', style: 'flex:1;min-width:0', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Адрес сервера' });
        const kind = h('select', { class: 'select', 'aria-label': 'Формат', style: 'flex:1;min-width:0' },
            [['openai', 'Формат OpenAI'], ['anthropic', 'Формат Anthropic']].map(([v, t]) => h('option', { value: v, text: t })));
        kind.value = cfg.kind || 'openai';
        const customRow = h('div', { class: 'field-row' }, url, kind);
        const showCustom = () => { customRow.hidden = provider.value !== 'custom'; };
        provider.addEventListener('change', showCustom);
        showCustom();
        const key = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', style: 'flex:1;min-width:0', 'aria-label': 'Ключ', placeholder: cfg.hasKey ? `сохранён ${cfg.keyHint} — вставьте новый, чтобы заменить` : 'вставьте ключ' });
        const listId = 'models-translate-key';
        const datalist = h('datalist', { id: listId });
        const model = h('input', { class: 'input mono', list: listId, value: cfg.model || '', placeholder: 'модель, например google/gemini-2.5-flash', style: 'flex:1;min-width:0', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Модель' });
        const fill = (list) => datalist.replaceChildren(...(list || []).slice(0, 1500).map(m => h('option', { value: m })));
        if (cfg.hasKey) api('/translate/key/models').then(r => fill(r.models)).catch(() => { });
        let on = cfg.on !== false;
        const status = h('span', { class: 'hint', text: cfg.checked?.message || (cfg.hasKey ? '' : 'Не задан: переводит подключение таверны') });
        const checkBtn = h('button', { class: 'btn small', type: 'button', text: 'Проверить и сохранить' });
        checkBtn.addEventListener('click', async () => {
            if (!cfg.hasKey && !key.value.trim()) {
                status.textContent = 'Сначала вставьте ключ';
                return;
            }
            checkBtn.disabled = true;
            status.textContent = 'Проверяю: прошу модель перевести одну строку…';
            try {
                const body = { provider: provider.value, model: model.value.trim(), on, check: true };
                if (provider.value === 'custom') Object.assign(body, { url: url.value.trim(), kind: kind.value });
                if (key.value.trim()) body.key = key.value.trim();
                const out = await api('/translate/key', { method: 'POST', body, timeout: 180000 });
                Object.assign(cfg, out);
                key.value = '';
                key.placeholder = `сохранён ${out.keyHint} — вставьте новый, чтобы заменить`;
                fill(out.check?.models);
                status.textContent = out.check?.message || 'Сохранено';
            } catch (error) {
                status.textContent = error.message;
            } finally {
                checkBtn.disabled = false;
            }
        });
        const removeBtn = h('button', { class: 'btn quiet small', type: 'button', text: 'Убрать ключ' });
        removeBtn.addEventListener('click', async () => {
            try {
                await api('/translate/key', { method: 'POST', body: { clear: true } });
                cfg.hasKey = false;
                key.placeholder = 'вставьте ключ';
                status.textContent = 'Ключ удалён: переводит подключение таверны';
            } catch (error) {
                status.textContent = error.message;
            }
        });
        put(box,
            h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Свой ключ для перевода' }),
                sw(on, (v) => { on = v; if (cfg.hasKey) api('/translate/key', { method: 'POST', body: { on: v } }).catch(() => { }); }, 'Переводить этим ключом')),
            h('div', { class: 'field-row' }, provider),
            customRow,
            h('div', { class: 'field-row' }, key),
            h('div', { class: 'field-row' }, model, datalist),
            h('div', { class: 'field-row', style: 'justify-content:flex-start;gap:8px' }, checkBtn, removeBtn),
            status,
            h('span', { class: 'hint', text: 'Чтобы перевод не тратил ключ таверны или переводила другая, быстрая модель. Ключ хранится только в этой таверне, не попадает в резервные копии и синхронизацию и сюда обратно не показывается. Когда ключ включён, перевод «Моделью Корректора» идёт с ним напрямую к сервису.' }));
    }).catch(() => put(box, h('span', { class: 'label', text: 'Свой ключ для перевода' }), h('span', { class: 'hint', text: 'Обновите Корректор, чтобы задать свой ключ для перевода' })));
    return box;
}

async function renderSettings(reload = true) {
    const view = $('#view');
    if (reload || !state.settings) {
        try {
            const [settings, worlds] = await Promise.all([api('/settings'), api('/worlds')]);
            state.settings = settings;
            state.worlds = worlds.items;
        } catch (error) {
            put(view, h('div', { class: 'empty' }, h('h2', { text: 'Не удалось загрузить настройки' }), h('p', { text: error.message })));
            return;
        }
    }
    const s = state.settings;
    const conn = state.status?.connection ?? {};

    const resolved = state.status?.models ?? {};
    const stApiText = conn.api === 'text'
        ? `Text Completion · ${conn.textType || '—'}`
        : conn.api === 'chat' ? `Chat Completion · ${SOURCE_NAME[conn.source] ?? conn.source ?? '—'}` : `${conn.mainApi} (не поддерживается)`;
    const stModel = conn.api === 'text' ? conn.textModel : conn.model;

    const tierBlock = (tier, title) => {
        const sourceKey = `${tier}Source`;
        const effectiveSource = s.models[sourceKey] || (conn.api === 'text' ? '' : conn.source);
        const source = h('select', { class: 'select', 'aria-label': 'Источник', style: 'flex:1;min-width:0' },
            h('option', { value: '', text: `Как в SillyTavern (${conn.api === 'text' ? 'Text Completion' : SOURCE_NAME[conn.source] ?? 'не выбран'})` }),
            SOURCES.map(([v, label]) => h('option', { value: v, text: label })));
        source.value = s.models[sourceKey] || '';
        source.addEventListener('change', () => save({ models: { [sourceKey]: source.value, [tier]: '' } }, true));

        const listId = `models-${tier}`;
        const model = h('input', {
            class: 'input mono', list: listId, value: s.models[tier] ?? '', style: 'flex:1;min-width:0',
            placeholder: resolved[tier]?.model || 'модель', 'aria-label': 'ID модели', autocapitalize: 'off', spellcheck: 'false',
        });
        model.addEventListener('change', () => save({ models: { [tier]: model.value.trim() } }, true));
        const datalist = h('datalist', { id: listId });
        if (effectiveSource) fillModels(effectiveSource, datalist);

        const efforts = [['auto', 'Рассуждение: как у модели'], ['low', 'Рассуждение: низкое'], ['medium', 'Рассуждение: среднее'], ['high', 'Рассуждение: высокое']];
        // Translation: as little thinking as the model allows, so it is quick ('low' was the old default).
        if (tier === 'translate') efforts.splice(0, 2, ['fast', 'Рассуждение: без него — быстрее'], ['auto', 'Рассуждение: как у модели']);
        const effort = h('select', { class: 'select', 'aria-label': 'Усилие рассуждения', style: 'flex:1;min-width:0' },
            efforts.map(([v, label]) => h('option', { value: v, text: label })));
        const savedEffort = s.models[`${tier}Effort`] || 'auto';
        effort.value = tier === 'translate' && (savedEffort === 'low' || savedEffort === 'fast') ? 'fast' : savedEffort;
        effort.addEventListener('change', () => save({ models: { [`${tier}Effort`]: effort.value } }));

        const max = h('input', { class: 'input mono', type: 'number', inputmode: 'numeric', min: 0, step: 256, value: s.models[`${tier}MaxTokens`] || '', placeholder: 'авто', style: 'width:96px;text-align:right', 'aria-label': 'Лимит ответа, токенов' });
        max.addEventListener('change', () => save({ models: { [`${tier}MaxTokens`]: Number(max.value) || 0 } }));

        const now = resolved[tier];
        return h('div', { class: 'field' },
            h('span', { class: 'label', text: title }),
            h('div', { class: 'field-row' }, source),
            h('div', { class: 'field-row' }, model, datalist),
            h('div', { class: 'field-row' }, effort),
            h('div', { class: 'field-row' }, h('span', { class: 'hint', text: 'Лимит ответа, токенов' }), max),
            h('span', { class: 'hint', text: now?.model ? `Сейчас: ${now.model} · ${now.why}` : 'Модель не выбрана: укажите её здесь или в SillyTavern' }));
    };

    const usesClaude = resolved.scan?.source === 'claude' && resolved.heavy?.source === 'claude';
    const recommendation = h('div', { class: 'field' },
        h('span', { class: 'hint', text: 'Подойдёт любой ИИ, ключ к которому сохранён в SillyTavern: Корректор просто вызывает его через SillyTavern. Наша рекомендация — Claude: Haiku 5.5 или Sonnet 5.5 для фоновой проверки, Opus 5.5 для сложных правок. С Claude эта пара включается сама, если поле модели пустое' }),
        h('div', { class: 'field-row', style: 'justify-content:flex-start;gap:8px;margin-top:4px' },
            !usesClaude ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => save({ models: { scanSource: 'claude', heavySource: 'claude', scan: RECOMMENDED.scan, heavy: RECOMMENDED.heavy } }, true), text: 'Использовать Claude' }) : null,
            (s.models.scanSource || s.models.heavySource || s.models.scan || s.models.heavy)
                ? h('button', { class: 'btn quiet small', type: 'button', onclick: () => save({ models: { scanSource: '', heavySource: '', scan: '', heavy: '' } }, true), text: 'Как в SillyTavern' })
                : null));

    const numberField = (label, hint, value, onchange, opts = {}) => {
        const input = h('input', { class: 'input mono', type: 'number', inputmode: 'numeric', value, min: opts.min ?? 0, max: opts.max, step: opts.step ?? 1, style: 'width:96px;text-align:right', 'aria-label': label });
        input.addEventListener('change', () => onchange(Number(input.value)));
        return h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: label }), input), hint ? h('span', { class: 'hint', text: hint }) : null);
    };
    const toggleField = (label, hint, value, onchange) => h('div', { class: 'field' },
        h('div', { class: 'field-row' }, h('span', { class: 'label', text: label }), sw(value, onchange, label)),
        hint ? h('span', { class: 'hint', text: hint }) : null);

    const summaryTarget = h('select', { class: 'select', 'aria-label': 'Куда сохранять резюме' },
        [['memory', 'Расширение Summarize'], ['note', 'Заметка автора'], ['lorebook', 'Лорбук чата']].map(([v, label]) => h('option', { value: v, text: label })));
    summaryTarget.value = s.summary.target;
    summaryTarget.addEventListener('change', () => save({ summary: { target: summaryTarget.value } }));

    const factsTarget = h('select', { class: 'select', 'aria-label': 'Куда добавлять факты', style: 'max-width:60%' },
        h('option', { value: '', text: 'Лорбук чата или персонажа' }),
        state.worlds.map(name => h('option', { value: name, text: name })));
    factsTarget.value = s.facts.targetWorld || '';
    factsTarget.addEventListener('change', () => save({ facts: { targetWorld: factsTarget.value } }));

    const interval = h('select', { class: 'select', 'aria-label': 'Как часто' },
        [10, 20, 30, 60, 120].map(n => h('option', { value: n, text: `раз в ${n} мин` })));
    interval.value = String(s.scan.intervalMinutes);
    interval.addEventListener('change', () => save({ scan: { intervalMinutes: Number(interval.value) } }));

    put(view, 
        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Подключение' }),
            h('div', { class: 'rows' },
                h('div', { class: 'field' },
                    h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'API в SillyTavern' }), h('span', { class: 'mono secondary', style: 'text-align:right', text: stApiText })),
                    h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Модель в SillyTavern' }), h('span', { class: 'mono secondary', style: 'overflow-wrap:anywhere;text-align:right', text: stModel || '—' })),
                    h('span', { class: 'hint', text: 'Запросы идут через бэкенд SillyTavern с его ключами. Корректор ключи не видит и secrets.json не читает' })))),
        tools.renderKeyCheck(),
        tools.inApp() ? null : h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Оформление' }),
            h('div', { class: 'rows' },
                h('div', { class: 'field' },
                    h('span', { class: 'label', text: 'Тема' }),
                    seg([['', 'Как в системе'], ['dark', 'Тёмная'], ['light', 'Светлая']], storageGet('korrektor.theme') || '', (v) => { window.korrektorTheme(v, storageGet('korrektor.accent')); renderSettings(false); })),
                h('div', { class: 'field' },
                    h('span', { class: 'label', text: 'Цвет акцента' }),
                    seg(tools.ACCENTS, storageGet('korrektor.accent') || 'amber', (v) => { window.korrektorTheme(storageGet('korrektor.theme'), v); renderSettings(false); })))),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Модели' }),
            h('div', { class: 'rows' },
                recommendation,
                tierBlock('scan', 'Дешёвая, для фоновой проверки'),
                tierBlock('heavy', 'Сильная, для сложных правок'),
                tierBlock('translate', 'Для перевода сообщений в чате (пусто — модель из «Какая модель для какой задачи»)'),
                translateKeyBlock())),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Какая модель для какой задачи' }),
            h('div', { class: 'rows' }, TASKS.map(([key, label]) => h('div', { class: 'field' },
                h('div', { class: 'field-row' }, h('span', { class: 'label', text: label }),
                    seg([['scan', 'Дешёвая'], ['heavy', 'Сильная']], s.tasks[key], (v) => save({ tasks: { [key]: v } }, true))))))),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Проверка' }),
            h('div', { class: 'rows' },
                toggleField('Замечания', s.scan.enabled === false
                    ? 'Выключены: Корректор ничего не проверяет и не присылает. Перевод, каталог, расходы, копии и «Попросить Корректора» работают'
                    : 'Искать проблемы в чатах, лорбуках и карточках и показывать их в ленте', s.scan.enabled !== false, (v) => setRemarks(v, { ask: false })),
                ...(s.scan.enabled === false ? [] : [
                toggleField('Проверять сама', 'В фоне, только чаты с новыми изменениями', s.scan.auto, (v) => save({ scan: { auto: v } })),
                h('div', { class: 'field' },
                    h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Какие чаты' }),
                        seg([['recent', 'Недавние'], ['watched', 'Отмеченные']], s.scan.mode, (v) => save({ scan: { mode: v } }, true))),
                    h('span', { class: 'hint', text: s.scan.mode === 'watched'
                        ? `Отмечено чатов: ${(s.scan.watched || []).length}. Отмечать — звёздочкой на вкладке «Чаты»`
                        : 'Последние изменённые чаты. Если чатов много, удобнее отметить нужные звёздочкой и выбрать «Отмеченные»' })),
                h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Как часто' }), interval)),
                s.scan.mode !== 'watched' ? numberField('Сколько недавних чатов', null, s.scan.recentChats, (v) => save({ scan: { recentChats: v } }), { min: 1, max: 20 }) : null,
                toggleField('Использовать модель', 'Для фактов и противоречий. В фоне — только после 4 новых сообщений', s.scan.useModel, (v) => save({ scan: { useModel: v } })),
                numberField('Сообщений за один запрос', null, s.scan.maxMessagesPerLlmScan, (v) => save({ scan: { maxMessagesPerLlmScan: v } }), { min: 5, max: 200 })]))),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Что искать' }),
            h('div', { class: 'rows' }, ANALYZERS.map(([key, label, hint]) =>
                toggleField(label, hint, s.analyzers[key], (v) => save({ analyzers: { [key]: v } }))))),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Пороги' }),
            h('div', { class: 'rows' },
                numberField('Предупреждать при заполнении контекста, %', null, Math.round(s.thresholds.contextWarn * 100), (v) => save({ thresholds: { contextWarn: v / 100 } }), { min: 30, max: 100 }),
                numberField('Карточка тяжелее, токенов', null, s.thresholds.cardTokens, (v) => save({ thresholds: { cardTokens: v } }), { step: 100 }),
                numberField('Промпт пресета тяжелее, токенов', null, s.thresholds.presetPromptTokens, (v) => save({ thresholds: { presetPromptTokens: v } }), { step: 100 }),
                numberField('Постоянная запись тяжелее, токенов', null, s.thresholds.entryTokens, (v) => save({ thresholds: { entryTokens: v } }), { step: 50 }),
                numberField('Фраза считается повтором, если встретилась в N ответах', null, s.thresholds.repeatMinMessages, (v) => save({ thresholds: { repeatMinMessages: v } }), { min: 2, max: 10 }))),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Резюме и факты' }),
            h('div', { class: 'rows' },
                h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Куда сохранять резюме' }), summaryTarget)),
                toggleField('Скрывать сжатые сообщения', 'Сообщения остаются в чате, но не идут в контекст. Вернуть: /unhide', s.summary.hideSummarized, (v) => save({ summary: { hideSummarized: v } })),
                numberField('Не трогать последние сообщения', null, s.summary.keepRecent, (v) => save({ summary: { keepRecent: v } }), { min: 10, max: 500 }),
                h('div', { class: 'field' },
                    h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Если стоит CharMemory' }),
                        seg([['skip', 'Факты не искать'], ['dedupe', 'Искать без повторов']], s.facts.withCharMemory, (v) => save({ facts: { withCharMemory: v } }, true))),
                    h('span', { class: 'hint', text: 'CharMemory сам собирает воспоминания в Data Bank. Корректор в любом случае читает их, чтобы не предлагать то же самое и сверять противоречия' })),
                h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'label', text: 'Куда добавлять факты' }), factsTarget),
                    h('span', { class: 'hint', text: 'Мемори-бук обычно подключён к чату как лорбук чата' })))),

        h('div', { class: 'section' },
            h('h2', { class: 'section-title', text: 'Уведомления' }),
            h('div', { class: 'rows' },
                toggleField('Уведомление Android о находках', state.status?.termux ? 'Через Termux:API' : 'Нужны приложение Termux:API и пакет termux-api: pkg install termux-api', s.notify.termux, (v) => save({ notify: { termux: v } })))),

        h('p', { class: 'small muted', style: 'margin:24px 0 0', text: `Приложение ${APP_VERSION} · плагин ${state.status?.version ?? '?'} · пользователь ${state.status?.user ?? ''}` }),
        state.status?.pluginDir ? h('p', { class: 'small muted mono', style: 'margin:4px 0 0;overflow-wrap:anywhere', text: `Плагин загружен из ${state.status.pluginDir}` }) : null,
    );
}

// ---------- misc ----------

function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

async function boot() {
    tools.setup({ h, put, $, api, toast, confirmDialog, fmt, when, plural, state, openSheet, renderCard, storageGet, storageSet, csrfToken, BASE, KIND });
    tools.applyTheme(storageGet('korrektor.theme'), storageGet('korrektor.accent'));
    // The Android app passes its look here, and links shared to the app.
    window.korrektorTheme = (theme, accent) => {
        storageSet('korrektor.theme', theme || '');
        storageSet('korrektor.accent', accent || '');
        tools.applyTheme(theme, accent);
    };
    // The Android app hands over a file shared to it (from Telegram).
    window.korrektorIncomingFile = (name, base64) => { tools.receiveFile(String(name || 'file'), String(base64 || '')); };
    window.korrektorImport = (url) => {
        state.importUrl = String(url || '');
        if (location.hash === '#tools/import') renderRoute();
        else location.hash = '#tools/import';
        setTimeout(() => { state.importUrl = ''; }, 1000);
    };
    $('#scan-button').addEventListener('click', () => startScan());
    window.addEventListener('hashchange', () => renderRoute());
    // Back to the app or to this tab: fresh data, but not on every quick tab switch.
    // Back to the app: fresh numbers. Only lists are redrawn — a page with a form keeps
    // what was typed (for example a link copied from another app).
    let fullAt = Date.now();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        const list = ['feed', 'chats', 'history'].includes(currentRoute().name);
        const full = list && Date.now() - fullAt > 20000;
        if (full) fullAt = Date.now();
        refresh(full);
    });
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => { });
    }
    await refresh();
    setInterval(() => { if (document.visibilityState === 'visible' && !state.job) refresh(false); }, 30000);
}

/** What the feed shows: the periodic refresh redraws it only when this changes. */
function feedKey() {
    const s = state.status || {};
    return JSON.stringify([state.proposals, s.open, s.lastScan, s.scanning?.id ?? null, s.connectionCheck?.ok ?? null]);
}

async function refresh(rerender = true) {
    const before = feedKey();
    // The chat list (for titles and marks) is heavier, so only on open and on return to the app.
    const results = await Promise.allSettled([loadStatus(), loadProposals(), rerender ? loadChats() : null]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed && !state.status) {
        put($('#view'), h('div', { class: 'empty' },
            tools.mascot('confused', 150),
            h('h2', { text: 'Нет связи с SillyTavern' }),
            h('p', { text: failed.reason?.message ?? '' })));
        return;
    }
    const route = currentRoute().name;
    // A redraw under the finger swallows the tap: on a timer only when there is something new.
    if (rerender || (route === 'feed' && feedKey() !== before)) renderRoute();
}

boot();
