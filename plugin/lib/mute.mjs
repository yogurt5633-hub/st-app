// "Learning from rejections": after three rejected findings of one kind within
// a month, the app asks once whether to stop showing that kind.

const WINDOW_MS = 30 * 86400000;
export const ASK_AFTER = 3;

export async function noteRejection(store, kind, now = Date.now()) {
    if (!kind || kind === 'manual' || kind === 'request') return { suggestMute: null, count: 0 };
    const settings = await store.getSettings();
    if ((settings.muted || []).includes(kind)) return { suggestMute: null, count: 0 };
    return store.updateState(state => {
        state.rejections = state.rejections || {};
        state.muteAsked = state.muteAsked || {};
        const list = (state.rejections[kind] || []).filter(t => now - Date.parse(t) < WINDOW_MS);
        list.push(new Date(now).toISOString());
        state.rejections[kind] = list.slice(-20);
        if (list.length >= ASK_AFTER && !state.muteAsked[kind]) {
            state.muteAsked[kind] = true;
            return { suggestMute: kind, count: list.length };
        }
        return { suggestMute: null, count: list.length };
    });
}

export async function setMuted(store, kind, muted) {
    const settings = await store.getSettings();
    const set = new Set(settings.muted || []);
    if (muted) set.add(String(kind));
    else set.delete(String(kind));
    const next = await store.saveSettings({ muted: [...set] });
    return next.muted;
}
