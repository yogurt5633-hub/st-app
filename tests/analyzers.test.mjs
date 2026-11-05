import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanKeys, analyzeDuplicates, analyzeKeys } from '../plugin/lib/analyzers/lorebook.mjs';
import { repeatedPhrases, findCliches, upsertNoteBlock, repeatedOpenings } from '../plugin/lib/analyzers/repetition.mjs';
import { extractJson, extractText } from '../plugin/lib/llm.mjs';
import { estimateTokens } from '../plugin/lib/tokens.mjs';
import { words } from '../plugin/lib/chat-context.mjs';
import { diffWords } from '../plugin/app/diff.js';

const item = (index, mes) => ({ index, message: { mes }, tokens: words(mes) });

test('cleanKeys drops stop words, short keys, broken regex and duplicates', () => {
    const { keys, reasons } = cleanKeys(['Амулет', 'он', ' амулет ', 'ок', '/[a-z/', '/ник(а|е)/i', 'Город']);
    assert.deepEqual(keys, ['Амулет', '/ник(а|е)/i', 'Город']);
    assert.ok(reasons.length >= 4);
});

test('duplicates: same text merges, same keys with different text asks a model', () => {
    const world = {
        name: 'Мир',
        data: {
            entries: {
                0: { uid: 0, key: ['амулет'], content: 'Серебряный амулет с лунным камнем.' },
                1: { uid: 1, key: ['кулон'], content: 'Серебряный амулет с лунным камнем.' },
                2: { uid: 2, key: ['порт'], content: 'Порт закрыт ночью.' },
                3: { uid: 3, key: ['порт'], content: 'В порту правит гильдия.' },
            },
        },
    };
    const found = analyzeDuplicates(world);
    assert.equal(found.length, 2);
    const merge = found.find(p => p.ops.length);
    assert.deepEqual(merge.ops[0].after.key, ['амулет', 'кулон']);
    assert.equal(merge.ops[1].op, 'world.deleteEntry');
    assert.equal(found.find(p => !p.ops.length).prepare.type, 'mergeEntries');
});

test('keys: entries without working keys get a model suggestion, constant ones are skipped', () => {
    const world = { name: 'Мир', data: { entries: { 0: { uid: 0, key: ['он'], content: 'x' }, 1: { uid: 1, key: [], constant: true, content: 'y' } } } };
    const found = analyzeKeys(world);
    assert.equal(found.length, 1);
    assert.equal(found[0].prepare.type, 'suggestKeys');
    assert.deepEqual(found[0].prepare.uids, [0]);
});

test('repeated passage shows once, in original wording', () => {
    const base = 'Лира усмехнулась и поправила кинжал на поясе. Ветер гнал по мостовой обрывки афиш.';
    const items = [item(0, base + ' Раз.'), item(2, 'Другое начало. ' + base), item(4, base), item(6, 'Совсем другой ответ про планы на вечер')];
    const phrases = repeatedPhrases(items, 3);
    assert.equal(phrases.length, 1);
    assert.ok(phrases[0].phrase.startsWith('Лира усмехнулась'));
    assert.equal(phrases[0].count, 3);
});

test('openings and clichés', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(i * 2, `Она медленно кивнула и сказала что-то своё номер ${i}. Мурашки побежали по её спине.`));
    assert.equal(repeatedOpenings(items).length, 1);
    const hits = findCliches(items);
    assert.equal(hits[0].id, 'ru-spine');
    assert.equal(hits[0].count, 6);
});

test('Author\'s Note block is replaced, not duplicated', () => {
    const once = upsertNoteBlock('Свой текст', 'тег', 'Первое');
    const twice = upsertNoteBlock(once, 'тег', 'Второе');
    assert.equal(twice, 'Свой текст\n\n<тег>\nВторое\n</тег>');
});

test('model replies: text from Claude blocks and OpenAI shape, JSON from fences', () => {
    assert.equal(extractText({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'ok' }], choices: [{ message: { content: '' } }] }), 'ok');
    assert.equal(extractText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
    assert.deepEqual(extractJson('Вот:\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('prefix {"facts":[]} suffix'), { facts: [] });
    assert.throws(() => extractJson('нет json'));
});

test('token estimate counts Cyrillic heavier than Latin', () => {
    assert.ok(estimateTokens('привет мир, как дела') > estimateTokens('hello world, how are'));
});

test('diff always reconstructs both texts', () => {
    const vocab = ['кот', ' ', ', ', 'и', 'the', '.', '\n', 'дом', 'ёж'];
    for (let i = 0; i < 500; i++) {
        const gen = () => Array.from({ length: Math.floor(Math.random() * 30) }, () => vocab[Math.floor(Math.random() * vocab.length)]).join('');
        const a = gen();
        const b = gen();
        const parts = diffWords(a, b);
        assert.equal(parts.filter(p => p[0] <= 0).map(p => p[1]).join(''), a);
        assert.equal(parts.filter(p => p[0] >= 0).map(p => p[1]).join(''), b);
    }
});
