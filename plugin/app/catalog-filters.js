// Shared by catalog forms, filtering and server-side metadata validation.
export const CATALOG_LANGUAGES = [['en', 'Английский'], ['ru', 'Русский'], ['th', 'Тайский'], ['zh', 'Китайский']];

export function catalogLanguage(value) {
    return CATALOG_LANGUAGES.some(([code]) => code === value) ? value : '';
}

export function matchesCatalogFilters(item, filters = {}) {
    const text = String(filters.text || '').trim().toLowerCase();
    return (!filters.type || filters.type === 'all' || item.type === filters.type)
        && (!filters.author || item.author === filters.author)
        && (!filters.model || (item.models || []).includes(filters.model))
        && (!filters.censor || item.uncensored === (filters.censor === 'no'))
        && (!filters.language || item.language === filters.language)
        && (!filters.translation || item.translated === (filters.translation === 'yes'))
        && (!text || [item.name, item.description, item.author, ...(item.tags || []), ...(item.models || [])].join(' ').toLowerCase().includes(text));
}
