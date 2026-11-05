/**
 * Rough token estimate without a tokenizer. Good enough to rank what eats
 * the context; the app always shows these numbers with "≈".
 * Cyrillic text costs more tokens per character than Latin.
 */
export function estimateTokens(text) {
    const value = String(text ?? '');
    if (!value) return 0;
    let latin = 0;
    let cyrillic = 0;
    let other = 0;
    for (const ch of value) {
        const code = ch.codePointAt(0);
        if (code < 0x80) latin++;
        else if (code >= 0x400 && code <= 0x4ff) cyrillic++;
        else other++;
    }
    return Math.ceil(latin / 3.8 + cyrillic / 2.6 + other / 1.5);
}

export function sumTokens(parts) {
    return parts.reduce((total, part) => total + estimateTokens(part), 0);
}
