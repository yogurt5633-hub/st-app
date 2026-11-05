import { cardTokens } from '../chat-context.mjs';
import { getCardField } from '../cards.mjs';
import { fieldTitle } from '../ops.mjs';
import { fingerprint, makeProposal } from '../proposals.mjs';

export function analyzeCardBloat({ avatar, card, name }, settings, contextSize) {
    const { total, breakdown } = cardTokens(card);
    const share = contextSize ? total / contextSize : 0;
    if (total < settings.thresholds.cardTokens && share < 0.3) return [];

    const fields = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    // Condense the fields that matter: the biggest ones that together make most of the card.
    const targets = fields.filter(([, tokens]) => tokens >= 150).slice(0, 4).map(([field]) => field);
    if (!targets.length) return [];

    return [makeProposal({
        kind: 'card_bloat',
        severity: share >= 0.4 ? 'high' : 'medium',
        title: `Карточка «${name}» съедает много токенов`,
        summary: contextSize
            ? `Постоянная часть карточки ≈${total.toLocaleString('ru-RU')} токенов, это ${Math.round(share * 100)}% контекста. Модель может переписать её короче, сохранив все факты и манеру речи`
            : `Постоянная часть карточки ≈${total.toLocaleString('ru-RU')} токенов. Модель может переписать её короче, сохранив все факты и манеру речи`,
        evidence: fields.map(([field, tokens]) => ({ label: `≈${tokens.toLocaleString('ru-RU')} т.`, text: fieldTitle(field) })),
        target: { type: 'card', avatar, label: name },
        fingerprint: fingerprint('card_bloat', avatar, targets.map(f => getCardField(card, f))),
        prepare: { type: 'condenseCard', avatar, fields: targets },
    })];
}
