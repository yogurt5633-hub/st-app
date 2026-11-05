// Корректор: quick backgrounds and avatars inside SillyTavern.
//  - Backgrounds: a grid of all backgrounds, one tap to switch, for all chats or only this chat
//    (the same "locked background" SillyTavern keeps in the chat's metadata).
//  - Avatar window: the character's picture in a floating window that can be moved and resized,
//    with a gallery of many pictures per character (SillyTavern's user/images/<character>/)
//    and one-tap switching, for this chat or for all chats with the character.
// Opened from the wand menu, or from the row above the tavern in the Korrektor app.

const ctx = () => SillyTavern.getContext();
const BG_KEY = 'custom_background';         // SillyTavern's own key for a chat's locked background
const AVATAR_KEY = 'korrektor_avatar';      // this chat: { [avatarFile]: imageUrl }
const WINDOW_KEY = 'korrektor.avatarWindow';
const MODE_KEY = 'korrektor.galleryMode';

export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
}

export function storage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

export function store(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // private mode: positions just are not remembered
    }
}

async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body ?? {}) });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json().catch(() => ({}));
}

// ---------- bottom sheet ----------

export function sheet(title, body, onClose) {
    document.querySelector('.kg-sheet')?.remove();
    const close = () => {
        root.remove();
        onClose?.();
    };
    const root = el('div', { class: 'kg-sheet', onclick: (e) => { if (e.target === root) close(); } },
        el('div', { class: 'kg-sheet-box' },
            el('div', { class: 'kg-sheet-head' },
                el('b', { text: title }),
                el('button', { class: 'kg-x menu_button', type: 'button', title: 'Закрыть', onclick: close, text: '✕' })),
            body));
    document.body.append(root);
    return { root, close };
}

function modeSwitch(value, onchange) {
    const box = el('div', { class: 'kg-seg' });
    const draw = (v) => {
        box.replaceChildren(...[['chat', 'Только этот чат'], ['all', 'Все чаты']].map(([key, label]) =>
            el('button', { type: 'button', class: v === key ? 'on' : '', onclick: () => { draw(key); onchange(key); }, text: label })));
    };
    draw(value);
    return box;
}

// ---------- backgrounds ----------

function bgUrl(file) {
    return `url("backgrounds/${encodeURIComponent(file)}")`;
}

async function openBackgrounds() {
    const c = ctx();
    let files = [];
    try {
        const data = await post('/api/backgrounds/all');
        const list = Array.isArray(data) ? data : Array.isArray(data?.images) ? data.images : [];
        files = list.map(x => (typeof x === 'string' ? x : x?.filename)).filter(Boolean);
    } catch {
        toastr.error('Не удалось получить список фонов');
        return;
    }
    const hasChat = Boolean(c.getCurrentChatId?.());
    let mode = hasChat && c.chatMetadata?.[BG_KEY] ? 'chat' : storage(MODE_KEY + '.bg', 'all');
    if (!hasChat) mode = 'all';
    const current = () => document.getElementById('bg1')?.style.backgroundImage || '';

    const grid = el('div', { class: 'kg-grid' });
    const draw = () => {
        grid.replaceChildren(...files.map(file => {
            const url = bgUrl(file);
            const on = current().includes(encodeURIComponent(file)) || current() === url;
            return el('button', { class: `kg-tile${on ? ' on' : ''}`, type: 'button', title: file, onclick: () => pick(file) },
                el('img', { src: `/thumbnail?type=bg&file=${encodeURIComponent(file)}`, loading: 'lazy', alt: '' }),
                el('span', { text: file.replace(/\.[^.]+$/, '') }));
        }));
    };
    const pick = async (file) => {
        const cc = ctx();
        const url = bgUrl(file);
        if (mode === 'chat') {
            if (!cc.getCurrentChatId?.()) {
                toastr.warning('Сначала откройте чат');
                return;
            }
            cc.chatMetadata[BG_KEY] = url;
            cc.saveMetadataDebounced();
            document.getElementById('bg1').style.backgroundImage = url;
        } else {
            if (cc.chatMetadata?.[BG_KEY]) {
                delete cc.chatMetadata[BG_KEY];
                cc.saveMetadataDebounced();
            }
            // SillyTavern's own picker sets the background for all chats and saves it.
            const node = [...document.querySelectorAll('.bg_example')].find(x => x.getAttribute('bgfile') === file);
            if (node) node.click();
            else await cc.executeSlashCommandsWithOptions(`/bg ${file}`, { handleExecutionErrors: true });
        }
        draw();
    };
    const body = el('div', {},
        hasChat ? modeSwitch(mode, (v) => { mode = v; store(MODE_KEY + '.bg', v); }) : el('p', { class: 'kg-hint', text: 'Чат не открыт: фон сменится для всех чатов' }),
        files.length ? grid : el('p', { class: 'kg-hint', text: 'Фонов пока нет. Загрузить их можно в меню фонов SillyTavern' }),
        hasChat ? el('div', { class: 'kg-actions' },
            el('button', { class: 'menu_button', type: 'button', text: 'Убрать фон этого чата', onclick: () => {
                const cc = ctx();
                delete cc.chatMetadata[BG_KEY];
                cc.saveMetadataDebounced();
                cc.executeSlashCommandsWithOptions('/unlockbg', { handleExecutionErrors: true });
                draw();
                toastr.info('Теперь у этого чата общий фон');
            } })) : null);
    draw();
    sheet('Фоны', body);
}

// ---------- avatar window ----------

let windowNode = null;
let observer = null;

function currentCharacter() {
    const c = ctx();
    if (c.groupId) {
        // In a group: the character who wrote the latest message.
        const last = [...(c.chat || [])].reverse().find(m => !m.is_user && !m.is_system);
        return c.characters.find(ch => ch.name === last?.name) || null;
    }
    return c.characters?.[c.characterId] ?? null;
}

function overrides() {
    const c = ctx();
    const chat = c.chatMetadata?.[AVATAR_KEY] || {};
    const all = c.extensionSettings?.korrektorGallery?.avatars || {};
    return { chat, all };
}

function chosenFor(character) {
    if (!character) return '';
    const { chat, all } = overrides();
    return chat[character.avatar] || all[character.avatar] || '';
}

function originalUrl(character) {
    return `/characters/${encodeURIComponent(character.avatar)}`;
}

/** Shows the chosen picture on this character's messages in the chat. */
function applyAvatars() {
    const c = ctx();
    const byName = new Map();
    for (const ch of c.characters || []) {
        const url = chosenFor(ch);
        if (url) byName.set(ch.name, url);
    }
    for (const mes of document.querySelectorAll('#chat .mes[is_user="false"]')) {
        const img = mes.querySelector('.avatar img');
        if (!img) continue;
        const url = byName.get(mes.getAttribute('ch_name'));
        if (url) {
            if (!img.dataset.kgOriginal) img.dataset.kgOriginal = img.getAttribute('src') || '';
            if (img.getAttribute('src') !== url) img.setAttribute('src', url);
        } else if (img.dataset.kgOriginal) {
            img.setAttribute('src', img.dataset.kgOriginal);
            delete img.dataset.kgOriginal;
        }
    }
    if (windowNode) drawWindow();
}

function watchChat() {
    if (observer) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    let queued = false;
    observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            applyAvatars();
        });
    });
    observer.observe(chat, { childList: true, subtree: false });
}

async function listPictures(character) {
    try {
        const list = await post('/api/images/list', { folder: character.name });
        return (Array.isArray(list) ? list : []).map(name => `/user/images/${encodeURIComponent(character.name)}/${encodeURIComponent(name)}`);
    } catch {
        return [];
    }
}

function choose(character, url, mode) {
    const c = ctx();
    if (mode === 'all') {
        c.extensionSettings.korrektorGallery = c.extensionSettings.korrektorGallery || { avatars: {} };
        const all = c.extensionSettings.korrektorGallery.avatars = c.extensionSettings.korrektorGallery.avatars || {};
        if (url) all[character.avatar] = url;
        else delete all[character.avatar];
        c.saveSettingsDebounced();
        // A choice for all chats replaces this chat's own choice.
        if (c.chatMetadata?.[AVATAR_KEY]?.[character.avatar]) {
            delete c.chatMetadata[AVATAR_KEY][character.avatar];
            c.saveMetadataDebounced();
        }
    } else {
        if (!c.getCurrentChatId?.()) {
            toastr.warning('Сначала откройте чат');
            return;
        }
        c.chatMetadata[AVATAR_KEY] = c.chatMetadata[AVATAR_KEY] || {};
        if (url) c.chatMetadata[AVATAR_KEY][character.avatar] = url;
        else delete c.chatMetadata[AVATAR_KEY][character.avatar];
        c.saveMetadataDebounced();
    }
    applyAvatars();
}

async function upload(character, files) {
    let added = 0;
    for (const file of files) {
        const format = (file.name.split('.').pop() || 'png').toLowerCase().replace('jpeg', 'jpg');
        const image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        try {
            await post('/api/images/upload', { image, format, ch_name: character.name, filename: `${Date.now()}-${added}` });
            added++;
        } catch {
            toastr.error(`Не удалось загрузить ${file.name}`);
        }
    }
    if (added) toastr.success(`Добавлено картинок: ${added}`);
}

function windowRect() {
    const saved = storage(WINDOW_KEY, null);
    const w = Math.min(window.innerWidth - 24, saved?.w ?? 220);
    const h = Math.min(window.innerHeight - 120, saved?.h ?? 300);
    const x = Math.min(Math.max(0, saved?.x ?? window.innerWidth - w - 12), window.innerWidth - 60);
    const y = Math.min(Math.max(0, saved?.y ?? 70), window.innerHeight - 60);
    return { x, y, w, h };
}

function dragger(handle, onMove, onEnd) {
    handle.addEventListener('pointerdown', (e) => {
        // Buttons in the title bar stay buttons.
        if (e.target.closest?.('button')) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        const move = (ev) => onMove(ev.clientX - startX, ev.clientY - startY, ev);
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            onEnd?.();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
        onMove(0, 0, e, true);
    });
}

function drawWindow() {
    const character = currentCharacter();
    const img = windowNode.querySelector('.kg-win-img');
    const name = windowNode.querySelector('.kg-win-name');
    if (!character) {
        name.textContent = 'Персонаж не выбран';
        img.removeAttribute('src');
        return;
    }
    name.textContent = character.name;
    const url = chosenFor(character) || originalUrl(character);
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
}

function toggleAvatarWindow() {
    if (windowNode) {
        windowNode.remove();
        windowNode = null;
        return;
    }
    const rect = windowRect();
    const head = el('div', { class: 'kg-win-head' },
        el('span', { class: 'kg-win-name' }),
        el('button', { class: 'kg-win-btn', type: 'button', title: 'Галерея', text: '☰', onclick: () => openGallery() }),
        el('button', { class: 'kg-win-btn', type: 'button', title: 'Закрыть', text: '✕', onclick: () => toggleAvatarWindow() }));
    const img = el('img', { class: 'kg-win-img', alt: '', onclick: () => openGallery() });
    const handle = el('div', { class: 'kg-win-resize', title: 'Потяните, чтобы изменить размер' });
    windowNode = el('div', { class: 'kg-win', style: `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px` }, head, img, handle);
    document.body.append(windowNode);

    let start = null;
    const save = () => store(WINDOW_KEY, { x: windowNode.offsetLeft, y: windowNode.offsetTop, w: windowNode.offsetWidth, h: windowNode.offsetHeight });
    dragger(head, (dx, dy, e, first) => {
        if (first) start = { x: windowNode.offsetLeft, y: windowNode.offsetTop };
        windowNode.style.left = `${Math.min(Math.max(0, start.x + dx), window.innerWidth - 60)}px`;
        windowNode.style.top = `${Math.min(Math.max(0, start.y + dy), window.innerHeight - 40)}px`;
    }, save);
    dragger(handle, (dx, dy, e, first) => {
        if (first) start = { w: windowNode.offsetWidth, h: windowNode.offsetHeight };
        windowNode.style.width = `${Math.max(120, Math.min(window.innerWidth - 8, start.w + dx))}px`;
        windowNode.style.height = `${Math.max(150, Math.min(window.innerHeight - 8, start.h + dy))}px`;
    }, save);
    drawWindow();
}

async function openGallery() {
    const character = currentCharacter();
    if (!character) {
        toastr.warning('Откройте чат с персонажем');
        return;
    }
    const c = ctx();
    const hasChat = Boolean(c.getCurrentChatId?.());
    let mode = hasChat ? storage(MODE_KEY + '.avatar', 'chat') : 'all';
    const grid = el('div', { class: 'kg-grid kg-grid-avatars' });
    const input = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    input.addEventListener('change', async () => {
        if (input.files?.length) await upload(character, [...input.files]);
        input.value = '';
        await draw();
    });
    const draw = async () => {
        const pictures = await listPictures(character);
        const chosen = chosenFor(character);
        const tile = (url, label, isOriginal) => {
            let timer = null;
            const node = el('button', { class: `kg-tile${(chosen === url || (!chosen && isOriginal)) ? ' on' : ''}`, type: 'button', title: label },
                el('img', { src: url, loading: 'lazy', alt: '' }), el('span', { text: label }));
            node.addEventListener('click', () => {
                choose(character, isOriginal ? '' : url, mode);
                draw();
            });
            // Long press: delete a picture from the gallery.
            if (!isOriginal) {
                node.addEventListener('pointerdown', () => {
                    timer = setTimeout(async () => {
                        if (!confirm('Удалить эту картинку из галереи персонажа?')) return;
                        const path = decodeURIComponent(url.replace(/^\//, ''));
                        try {
                            await post('/api/images/delete', { path });
                            if (chosenFor(character) === url) choose(character, '', mode);
                        } catch {
                            toastr.error('Не удалось удалить');
                        }
                        draw();
                    }, 700);
                });
                for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(ev, () => clearTimeout(timer));
            }
            return node;
        };
        grid.replaceChildren(
            tile(originalUrl(character), 'Исходная', true),
            ...pictures.map((url, i) => tile(url, String(i + 1), false)),
            el('button', { class: 'kg-tile kg-add', type: 'button', onclick: () => input.click() }, el('b', { text: '+' }), el('span', { text: 'Добавить' })));
    };
    const body = el('div', {},
        hasChat ? modeSwitch(mode, (v) => { mode = v; store(MODE_KEY + '.avatar', v); }) : null,
        grid,
        input,
        el('p', { class: 'kg-hint', text: 'Нажмите на картинку, чтобы она стала аватаркой. Долгое нажатие — удалить. Картинки хранятся в галерее персонажа SillyTavern' }),
        el('div', { class: 'kg-actions' },
            el('button', { class: 'menu_button', type: 'button', text: windowNode ? 'Скрыть окно' : 'Показать в окне', onclick: () => { toggleAvatarWindow(); closeSheet(); } })));
    const { close: closeSheet } = sheet(`Аватар: ${character.name}`, body);
    await draw();
}

// ---------- entry points ----------

function addMenuItems() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('korrektor_bg_menu')) return Boolean(menu);
    menu.append(
        el('div', { id: 'korrektor_bg_menu', class: 'list-group-item flex-container flexGap5', onclick: () => openBackgrounds() },
            el('div', { class: 'fa-solid fa-image extensionsMenuExtensionButton' }), el('span', { text: 'Фоны' })),
        el('div', { id: 'korrektor_avatar_menu', class: 'list-group-item flex-container flexGap5', onclick: () => openGallery() },
            el('div', { class: 'fa-solid fa-user-astronaut extensionsMenuExtensionButton' }), el('span', { text: 'Аватар персонажа' })));
    return true;
}

export function initGallery() {
    window.korrektorGallery = {
        backgrounds: openBackgrounds,
        avatar: () => (windowNode ? openGallery() : (toggleAvatarWindow(), undefined)),
        gallery: openGallery,
        toggleWindow: toggleAvatarWindow,
    };
    const timer = setInterval(() => { if (addMenuItems()) clearInterval(timer); }, 1000);
    try {
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            watchChat();
            setTimeout(applyAvatars, 100);
        });
    } catch {
        // older SillyTavern without events: the observer still works once the chat exists
    }
    watchChat();
}
