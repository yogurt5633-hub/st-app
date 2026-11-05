import { cardTokens } from './chat-context.mjs';
import { getCardField } from './cards.mjs';
import { estimateTokens } from './tokens.mjs';
import { OPEN_STATUSES } from './proposals.mjs';

// "Card health": a score 0..100 with plain tips. No model involved: size of
// the fields, missing parts, markup junk, repeated lines and open problems
// that Korrektor already found for this card.

const JUNK = [
    [/<\/?(div|span|style|font|br|p|img|table|center)\b/i, 'HTML-разметка'],
    [/```/, 'блоки кода'],
    [/!\[[^\]]*\]\([^)]*\)/, 'картинки Markdown'],
    [/https?:\/\/\S+/i, 'ссылки'],
];

function repeatedLines(text) {
    const seen = new Set();
    let repeats = 0;
    for (const raw of String(text).split(/\n+|(?<=[.!?…])\s+/)) {
        const line = raw.trim().toLowerCase();
        if (line.length < 25) continue;
        if (seen.has(line)) repeats++;
        seen.add(line);
    }
    return repeats;
}

/**
 * @param card       card object (V2/V3)
 * @param proposals  all proposals, to count open ones for this card
 * @param contextSize the model's context, to judge the size (0 = unknown)
 */
export function cardHealth(card, avatar, { proposals = [], contextSize = 0 } = {}) {
    const tips = [];
    let score = 100;
    const take = (points, level, text) => {
        score -= points;
        tips.push({ level, text, points });
    };

    const { total, breakdown } = cardTokens(card);
    const description = getCardField(card, 'description');
    const first = getCardField(card, 'first_mes');
    const examples = getCardField(card, 'mes_example');
    const personality = getCardField(card, 'personality');
    const scenario = getCardField(card, 'scenario');
    const descTokens = estimateTokens(description);

    if (!description.trim()) take(30, 'high', 'Нет описания персонажа: модели не на что опереться');
    else if (descTokens < 60) take(15, 'medium', `Описание очень короткое (≈${descTokens} токенов): добавьте внешность, характер, манеру речи`);

    const share = contextSize ? total / contextSize : 0;
    if (total > 3500 || share > 0.35) take(25, 'high', `Карточка большая: ≈${total.toLocaleString('ru-RU')} токенов${share ? `, ${Math.round(share * 100)}% контекста` : ''}. Корректор может сжать её без потери фактов`);
    else if (total > 2000 || share > 0.2) take(10, 'medium', `Карточка заметно длинная: ≈${total.toLocaleString('ru-RU')} токенов в каждом запросе`);

    if (!first.trim()) take(15, 'medium', 'Нет первого сообщения: чат начнётся с пустого места');
    else if (estimateTokens(first) > 1200) take(5, 'low', 'Первое сообщение очень длинное: модель будет подражать этой длине');

    if (!examples.trim()) take(10, 'medium', 'Нет примеров диалога: с ними модель лучше держит голос персонажа');
    if (!personality.trim() && !scenario.trim()) take(5, 'low', 'Пустые поля «Характер» и «Сценарий»: если это важно, вынесите туда главное');

    const junk = new Set();
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
        const text = getCardField(card, field);
        for (const [re, label] of JUNK) if (re.test(text)) junk.add(label);
    }
    if (junk.size) take(Math.min(15, junk.size * 5), 'medium', `Лишнее в тексте карточки: ${[...junk].join(', ')}. Это тратит токены и сбивает модель`);

    const repeats = repeatedLines(`${description}\n${personality}\n${scenario}`);
    if (repeats) take(Math.min(10, repeats * 3), 'low', `Одни и те же фразы повторяются (${repeats}): их можно убрать`);

    const open = proposals.filter(p => OPEN_STATUSES.includes(p.status) && p.target?.avatar === avatar);
    if (open.length) take(Math.min(20, open.length * 5), 'medium', `Открытых замечаний Корректора по этой карточке: ${open.length}`);

    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
        avatar,
        score,
        verdict: score >= 80 ? 'В порядке' : score >= 50 ? 'Есть что улучшить' : 'Стоит поправить',
        tokens: total,
        fields: breakdown,
        tips: tips.sort((a, b) => b.points - a.points).map(({ level, text }) => ({ level, text })),
        open: open.map(p => p.id),
    };
}
