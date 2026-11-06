// Reading a model's answer as it is written (server-sent events), whatever the provider:
// OpenAI-style chunks (OpenAI, OpenRouter, DeepSeek, custom addresses, …), Claude's events and
// Gemini's chunks — SillyTavern passes each provider's stream along as it is.

/** Feeds text chunks in, calls onEvent(json) for every `data:` line with JSON. */
export function sseParser(onEvent) {
    let buffer = '';
    let events = 0;
    const line = (raw) => {
        const text = raw.replace(/\r$/, '');
        if (!text.startsWith('data:')) return;
        const data = text.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let json;
        try {
            json = JSON.parse(data);
        } catch {
            return;
        }
        events++;
        onEvent(json);
    };
    return {
        push(chunk) {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf('\n')) >= 0) {
                line(buffer.slice(0, at));
                buffer = buffer.slice(at + 1);
            }
        },
        end() {
            if (buffer) line(buffer);
            buffer = '';
        },
        get events() {
            return events;
        },
    };
}

/**
 * The answer's text in one event, and why it stopped when it did. Thinking is left out
 * (OpenAI-style `reasoning`, Claude's thinking blocks, Gemini's thought parts).
 */
export function streamDelta(json) {
    if (json?.error) {
        const message = typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error).slice(0, 200);
        return { error: message };
    }
    const choice = json?.choices?.[0];
    if (choice) {
        const content = choice.delta?.content ?? choice.text ?? choice.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('') : '';
        return { text, finish: choice.finish_reason || null };
    }
    if (json?.type === 'content_block_delta') return { text: json.delta?.type === 'text_delta' ? String(json.delta.text || '') : '' };
    if (json?.type === 'message_delta') return { text: '', finish: json.delta?.stop_reason || null };
    if (json?.type === 'error') return { error: json.error?.message || 'ошибка провайдера' };
    const candidate = json?.candidates?.[0];
    if (candidate) {
        const text = (candidate.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        return { text, finish: candidate.finishReason || null };
    }
    return { text: '' };
}

export const CUT_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
