// Remembers which files the plugin changed, so the companion extension in the
// SillyTavern tab can reload an open chat instead of overwriting the fix.

const touched = new Map();
const KEEP_MS = 10 * 60 * 1000;

export function markTouched(handle, type, ref) {
    const list = touched.get(handle) ?? [];
    const now = Date.now();
    list.push({ type, ref, at: now });
    touched.set(handle, list.filter(item => now - item.at < KEEP_MS));
}

export function touchedSince(handle, since) {
    const list = touched.get(handle) ?? [];
    return list.filter(item => item.at > since);
}
