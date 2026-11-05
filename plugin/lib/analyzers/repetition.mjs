import { characterMessages, chatLanguageIsRussian, plainText, words } from '../chat-context.mjs';
import { messageText } from '../chats.mjs';
import { fingerprint, makeProposal } from '../proposals.mjs';
import { truncate } from '../util.mjs';
import { plural } from './lorebook.mjs';

const STOP = new Set([
    // ru
    'и', 'в', 'во', 'не', 'на', 'с', 'со', 'что', 'как', 'а', 'но', 'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'его', 'её', 'ее', 'их',
    'к', 'ко', 'по', 'за', 'из', 'от', 'до', 'у', 'о', 'об', 'же', 'ли', 'бы', 'то', 'это', 'так', 'было', 'был', 'была', 'были', 'быть', 'есть',
    'мне', 'меня', 'тебя', 'тебе', 'ему', 'ей', 'им', 'себя', 'свой', 'своей', 'своим', 'для', 'при', 'над', 'под', 'чтобы', 'когда', 'если', 'уже', 'ещё', 'еще',
    // en
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'as', 'by', 'is', 'was', 'were', 'be', 'been', 'it', 'its',
    'he', 'she', 'they', 'his', 'her', 'their', 'him', 'them', 'you', 'your', 'i', 'my', 'me', 'we', 'our', 'that', 'this', 'from', 'into', 'up', 'out',
]);

const meaningful = (word) => word.length >= 3 && !STOP.has(word);

/**
 * Repeated passages: positions covered by any 4-word phrase that occurs in
 * several messages are joined into the longest runs, so one long copied
 * sentence shows up once instead of as many overlapping pieces.
 */
export function repeatedPhrases(items, minDocs) {
    const N = 4;
    const docs = new Map();
    for (const { index, tokens } of items) {
        const seen = new Set();
        for (let i = 0; i + N <= tokens.length; i++) {
            const gram = tokens.slice(i, i + N);
            if (gram.filter(meaningful).length < 2) continue;
            const key = gram.join(' ');
            if (seen.has(key)) continue;
            seen.add(key);
            if (!docs.has(key)) docs.set(key, new Set());
            docs.get(key).add(index);
        }
    }
    const repeated = new Set([...docs.entries()].filter(([, set]) => set.size >= minDocs).map(([key]) => key));
    if (!repeated.size) return [];

    const runs = new Map();
    for (const { tokens } of items) {
        const covered = new Array(tokens.length).fill(false);
        for (let i = 0; i + N <= tokens.length; i++) {
            if (repeated.has(tokens.slice(i, i + N).join(' '))) covered.fill(true, i, i + N);
        }
        for (let i = 0; i < tokens.length;) {
            if (!covered[i]) { i++; continue; }
            let j = i;
            while (j < tokens.length && covered[j]) j++;
            const run = tokens.slice(i, j).join(' ');
            runs.set(run, (runs.get(run) ?? 0) + 1);
            i = j;
        }
    }

    // How many messages contain each run (a run may sit inside a longer one elsewhere).
    const texts = items.map(({ index, tokens }) => ({ index, text: ` ${tokens.join(' ')} ` }));
    const result = [];
    for (const run of runs.keys()) {
        const indices = texts.filter(t => t.text.includes(` ${run} `)).map(t => t.index);
        if (indices.length >= minDocs) result.push({ phrase: run, count: indices.length, indices });
    }
    const contains = (outer, inner) => ` ${outer} `.includes(` ${inner} `);
    // Drop a run inside a longer one that is just as frequent, and a run that only extends a more frequent one.
    const byLength = result.sort((a, b) => b.phrase.length - a.phrase.length)
        .filter((r, i, all) => !all.slice(0, i).some(o => o.count >= r.count && contains(o.phrase, r.phrase)));
    const kept = [];
    for (const r of byLength.sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length)) {
        if (kept.some(o => contains(r.phrase, o.phrase))) continue;
        kept.push(r);
    }
    const byText = new Map(items.map(({ index, message }) => [index, plainText(messageText(message))]));
    const seen = new Set();
    const out = [];
    for (const r of kept) {
        const phrase = displayPhrase(r.phrase, byText.get(r.indices[0]) ?? '');
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        out.push({ ...r, phrase });
    }
    return out.slice(0, 8);
}

/** First words of the phrase as written in the message (original case and punctuation). */
function displayPhrase(normalized, original, max = 12) {
    const list = normalized.split(' ');
    const head = list.slice(0, max);
    const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/е/g, '[её]');
    const re = new RegExp(head.map(escape).join("[^\\p{L}\\p{N}']+"), 'iu');
    const match = original.match(re);
    const text = match ? match[0] : head.join(' ');
    return list.length > max ? `${text}…` : text;
}

function shingles(tokens) {
    const set = new Set();
    for (let i = 0; i + 3 <= tokens.length; i++) set.add(tokens.slice(i, i + 3).join(' '));
    return set;
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

export function repeatedOpenings(items) {
    const counts = new Map();
    for (const { index, tokens } of items.slice(-12)) {
        if (tokens.length < 6) continue;
        const key = tokens.slice(0, 3).join(' ');
        if (!counts.has(key)) counts.set(key, []);
        counts.get(key).push(index);
    }
    return [...counts.entries()].filter(([, list]) => list.length >= 4).map(([opening, indices]) => ({ opening, indices }));
}

export function loopPairs(items) {
    const pairs = [];
    const recent = items.slice(-6);
    for (let i = 1; i < recent.length; i++) {
        const score = jaccard(shingles(recent[i - 1].tokens), shingles(recent[i].tokens));
        if (score >= 0.35) pairs.push({ a: recent[i - 1].index, b: recent[i].index, score });
    }
    return pairs;
}

/** Replaces or appends a tagged block inside the Author's Note. */
export function upsertNoteBlock(note, tag, body) {
    const current = String(note ?? '');
    const block = `<${tag}>\n${body}\n</${tag}>`;
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
    if (re.test(current)) return current.replace(re, block);
    return current.trim() ? `${current.trim()}\n\n${block}` : block;
}

function noteOps(cc, tag, body) {
    const meta = cc.chat.header?.chat_metadata || {};
    const before = typeof meta.note_prompt === 'string' ? meta.note_prompt : '';
    const ops = [{ op: 'chat.setMeta', chatId: cc.chatId, key: 'note_prompt', before, after: upsertNoteBlock(before, tag, body) }];
    if (meta.note_interval === 0) {
        // Interval 0 switches the Author's Note off; turn it on so the hint works.
        ops.push({ op: 'chat.setMeta', chatId: cc.chatId, key: 'note_interval', before: 0, after: 1 });
    }
    return ops;
}

function tokenize(cc) {
    return characterMessages(cc.chat).slice(-30).map(({ message, index }) => ({ index, message, tokens: words(messageText(message)) }));
}

export function analyzeRepetition(cc, settings) {
    if (!cc.chat.header) return [];
    const items = tokenize(cc);
    if (items.length < 4) return [];

    const phrases = repeatedPhrases(items, settings.thresholds.repeatMinMessages);
    const openings = repeatedOpenings(items);
    const loops = loopPairs(items);
    if (phrases.length < 2 && !openings.length && loops.length < 2) return [];

    const ru = chatLanguageIsRussian(cc.chat);
    const evidence = [];
    if (loops.length >= 2) {
        evidence.push({ label: 'Зацикливание', text: `${loops.length} пары подряд идущих ответов почти совпадают (сходство до ${Math.round(Math.max(...loops.map(l => l.score)) * 100)}%)`, index: loops[loops.length - 1].b });
    }
    for (const p of phrases.slice(0, 5)) {
        evidence.push({ label: `${p.count} раз`, text: `«${p.phrase}»`, index: p.indices[p.indices.length - 1] });
    }
    for (const o of openings) {
        const sample = items.find(it => it.index === o.indices[0]);
        const opening = displayPhrase(o.opening, plainText(messageText(sample?.message)));
        evidence.push({ label: 'Одинаковое начало', text: `${o.indices.length} ${plural(o.indices.length, 'ответ начинается', 'ответа начинаются', 'ответов начинаются')} с «${opening}…»`, index: o.indices[o.indices.length - 1] });
    }

    const list = phrases.slice(0, 6).map(p => `«${p.phrase}»`).join(', ');
    const lines = ru
        ? [
            list && `Не повторяй эти обороты из прошлых ответов: ${list}.`,
            openings.length && 'Начинай каждый ответ по-новому, не с одних и тех же слов.',
            loops.length >= 2 && 'Не пересказывай свой прошлый ответ: продвигай сцену, добавляй новые действия и детали.',
        ]
        : [
            list && `Do not reuse these phrases from earlier replies: ${list.replace(/[«»]/g, '"')}.`,
            openings.length && 'Start each reply differently, not with the same words.',
            loops.length >= 2 && 'Do not restate your previous reply: move the scene forward with new actions and details.',
        ];
    const body = lines.filter(Boolean).join('\n');
    const last = items[items.length - 1];

    return [makeProposal({
        kind: 'repetition',
        severity: loops.length >= 2 ? 'high' : phrases.length >= 5 ? 'medium' : 'low',
        title: loops.length >= 2 ? 'Ответы зацикливаются' : 'Повторяющиеся фразы',
        summary: 'Персонаж повторяет одни и те же обороты. Предлагаю добавить в заметку автора короткое указание, чтобы модель их избегала',
        evidence,
        target: { type: 'chat', chatId: cc.chatId, label: cc.title },
        fingerprint: fingerprint('repetition', cc.chatId, phrases.slice(0, 3).map(p => p.phrase).sort(), openings.map(o => o.opening), loops.length >= 2),
        ops: noteOps(cc, ru ? 'избегай-повторов' : 'avoid-repeats', body),
        followups: [{
            type: 'rewriteMessage',
            label: 'Переписать последний ответ без повторов',
            params: { chatId: cc.chatId, index: last.index, phrases: phrases.slice(0, 6).map(p => p.phrase), reason: 'repetition' },
        }],
    })];
}

// Common clichés of model-written roleplay prose. Each counts once per message.
export const CLICHES = [
    // en
    { id: 'spine', re: /shivers? (?:run(?:s|ning)? |ran )?(?:up and )?down (?:her|his|my|your|their) spine/i, label: 'shivers down the spine' },
    { id: 'whisper', re: /barely above a whisper/i, label: 'barely above a whisper' },
    { id: 'ministrations', re: /ministrations/i, label: 'ministrations' },
    { id: 'mixof', re: /\ba mix(?:ture)? of [a-z]+ and [a-z]+/i, label: 'a mix of X and Y' },
    { id: 'mischief', re: /(?:sparkl\w*|glint\w*|twinkl\w*|gleam\w*) (?:with|of) (?:mischief|amusement)|mischievous (?:glint|twinkle|grin|sparkle)/i, label: 'mischievous glint' },
    { id: 'maybe', re: /maybe,? just maybe/i, label: 'maybe, just maybe' },
    { id: 'testament', re: /a testament to/i, label: 'a testament to' },
    { id: 'airthick', re: /the air (?:was |is |grew |hung )?(?:thick|heavy|charged|electric) with/i, label: 'the air thick with' },
    { id: 'couldnthelp', re: /(?:couldn't|could not|can't) help but/i, label: "couldn't help but" },
    { id: 'pop', re: /(?:with )?an audible pop/i, label: 'an audible pop' },
    { id: 'ruin', re: /ruin (?:you|me|her|him) for (?:anyone|anybody) else/i, label: 'ruin you for anyone else' },
    { id: 'breath', re: /breath (?:hitch(?:es|ed)?|catch(?:es)? in (?:her|his) throat)/i, label: 'breath hitches' },
    { id: 'jolt', re: /(?:a )?jolt of electricity|sending (?:a )?(?:jolts?|shivers?|waves?) (?:of [a-z]+ )?(?:through|down)/i, label: 'a jolt of electricity' },
    { id: 'oldastime', re: /(?:dance|game) as old as time/i, label: 'a dance as old as time' },
    { id: 'littledid', re: /little did (?:she|he|they|I|we) know/i, label: 'little did they know' },
    { id: 'ozone', re: /(?:smell|scent) of ozone|petrichor/i, label: 'the scent of ozone' },
    { id: 'tapestry', re: /\btapestry of\b|\bkaleidoscope of\b/i, label: 'a tapestry of' },
    { id: 'notjust', re: /it(?:'s| is| was) not (?:just )?about [^.,;]{1,40}[,;] it(?:'s| is| was) about/i, label: "it's not about X, it's about Y" },
    { id: 'lip', re: /(?:bit|bites|biting|nibbl\w+|worr\w+) (?:on )?(?:her|his) (?:lower |bottom )?lip/i, label: 'bites her lip' },
    { id: 'eyesdarken', re: /eyes (?:darken(?:ed|ing)?|smoldering) with (?:desire|lust|need)/i, label: 'eyes darkened with desire' },
    // ru
    { id: 'ru-spine', re: /мурашки (?:побежали|пробежали|бегут) по (?:её |его |моей |твоей )?(?:спине|коже)/i, label: 'мурашки по спине' },
    { id: 'ru-whisper', re: /(?:чуть|едва|немногим) громче шёпота|едва слышн\w+ шёпот/i, label: 'едва громче шёпота' },
    { id: 'ru-mischief', re: /(?:озорн|хитр|игрив|лукав)\w+ (?:огон[её]к|искорк\w*|блеск\w*)/i, label: 'озорной огонёк в глазах' },
    { id: 'ru-mix', re: /(?:смесь|смесью|смеси) (?:\p{L}+ )?(?:\p{L}+) и (?:\p{L}+)/iu, label: 'смесь X и Y' },
    { id: 'ru-testament', re: /(?:было|стало|является) (?:живым )?(?:свидетельством|доказательством) (?:того|её|его)/i, label: 'свидетельство того' },
    { id: 'ru-air', re: /воздух (?:был |стал |казался )?(?:густ\w+|пропитан\w*|наэлектризован\w*|тяж[её]л\w+) (?:от|напряжени\w*|ожидани\w*)/i, label: 'воздух, густой от напряжения' },
    { id: 'ru-couldnt', re: /(?:не мог(?:ла|ли)?|не может) не (?:\p{L}+)/iu, label: 'не могла не' },
    { id: 'ru-wave', re: /по (?:её |его |моему |твоему )?телу (?:пробежала|прокатилась|разлилась) (?:волна|дрожь)/i, label: 'по телу пробежала волна' },
    { id: 'ru-heart', re: /сердце (?:пропустило удар|ухнуло|забилось чаще|бешено колотилось)/i, label: 'сердце пропустило удар' },
    { id: 'ru-lip', re: /(?:прикусил|прикусила|закусил|закусила) (?:нижнюю )?губу/i, label: 'прикусила губу' },
    { id: 'ru-maybe', re: /(?:может быть|возможно), (?:просто |всего лишь )?(?:может быть|возможно)/i, label: 'может быть, просто может быть' },
    { id: 'ru-world', re: /(?:весь )?мир (?:вокруг )?(?:исчез|растворился|перестал существовать|сузился до)/i, label: 'мир вокруг исчез' },
    { id: 'ru-electric', re: /(?:электрическ\w+ (?:разряд|ток|искр\w*)|словно (?:током|электрическим током)) (?:пробежал\w*|прош[её]л\w*|ударил\w*)/i, label: 'словно током ударило' },
    { id: 'ru-oldworld', re: /(?:танец|игра)(?:,)? (?:старая|старый) как (?:мир|время)/i, label: 'игра, старая как мир' },
    { id: 'ru-notabout', re: /дело не (?:только |просто )?в [^.,;]{1,40}[,;] (?:а |дело )?в/i, label: 'дело не в X, а в Y' },
    { id: 'ru-pupils', re: /зрачки (?:расширились|потемнели)|глаза потемнели от (?:желания|страсти)/i, label: 'зрачки расширились' },
    { id: 'ru-breath', re: /дыхание (?:перехватило|сбилось|участилось)/i, label: 'дыхание перехватило' },
    { id: 'ru-tapestry', re: /гобелен\w* (?:из|событий|судеб)|калейдоскоп\w* (?:эмоций|чувств|красок)/i, label: 'калейдоскоп эмоций' },
];

export function findCliches(items) {
    const hits = new Map();
    for (const { index, message } of items) {
        const text = plainText(messageText(message));
        for (const cliche of CLICHES) {
            const match = text.match(cliche.re);
            if (!match) continue;
            if (!hits.has(cliche.id)) hits.set(cliche.id, { ...cliche, count: 0, indices: [], example: '' });
            const hit = hits.get(cliche.id);
            hit.count++;
            hit.indices.push(index);
            const at = match.index ?? 0;
            hit.example = truncate(text.slice(Math.max(0, at - 40), at + match[0].length + 40).trim(), 160);
        }
    }
    return [...hits.values()].sort((a, b) => b.count - a.count);
}

export function analyzeSlop(cc) {
    if (!cc.chat.header) return [];
    const items = tokenize(cc);
    if (items.length < 4) return [];
    const hits = findCliches(items);
    const total = hits.reduce((sum, h) => sum + h.count, 0);
    const strong = hits.filter(h => h.count >= 2);
    if (strong.length < 3 && total < 8) return [];

    const ru = chatLanguageIsRussian(cc.chat);
    const top = hits.slice(0, 8);
    const list = top.map(h => `«${h.label}»`).join(', ');
    const body = ru
        ? `Пиши свежо и конкретно. Не используй штампы: ${list}. Вместо готовых формул описывай то, что видно и слышно в этой сцене.`
        : `Write fresh, concrete prose. Avoid these clichés: ${list.replace(/[«»]/g, '"')}. Instead of stock phrases, describe what is actually seen and heard in this scene.`;

    return [makeProposal({
        kind: 'slop',
        severity: total >= 15 ? 'medium' : 'low',
        title: 'Штампы в ответах',
        summary: `За последние ${items.length} ответов найдено ${total} типичных штампов модели. Предлагаю попросить её писать без них через заметку автора`,
        evidence: top.slice(0, 6).map(h => ({ label: `${h.count}×`, text: h.example || h.label, index: h.indices[h.indices.length - 1] })),
        target: { type: 'chat', chatId: cc.chatId, label: cc.title },
        fingerprint: fingerprint('slop', cc.chatId, top.slice(0, 3).map(h => h.id).sort()),
        ops: noteOps(cc, ru ? 'без-штампов' : 'avoid-cliches', body),
        followups: [{
            type: 'rewriteMessage',
            label: 'Переписать последний ответ без штампов',
            params: { chatId: cc.chatId, index: items[items.length - 1].index, phrases: top.map(h => h.label), reason: 'slop' },
        }],
    })];
}
