import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, instructPrompt, stripThinking } from '../plugin/lib/llm.mjs';
import { DEFAULT_SETTINGS } from '../plugin/lib/store.mjs';

const settings = (models = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, ...models } });
const st = (oai, extra = {}) => ({ main_api: 'openai', oai_settings: oai, ...extra });
const client = (models, stSettings) => new LlmClient({ auth: { port: 1 }, settings: settings(models), stSettings });

test('defaults follow SillyTavern: any provider, its selected model', () => {
    const c = client({}, st({ chat_completion_source: 'openrouter', openrouter_model: 'deepseek/deepseek-chat' }));
    assert.deepEqual([c.resolveTier('scan').model, c.resolveTier('heavy').model], ['deepseek/deepseek-chat', 'deepseek/deepseek-chat']);
    assert.equal(c.resolveTier('scan').why, 'как в SillyTavern');
});

test('Claude in SillyTavern: the recommended pair is used when fields are empty', () => {
    const c = client({}, st({ chat_completion_source: 'claude', claude_model: 'claude-sonnet-5-5' }));
    assert.equal(c.resolveTier('scan').model, 'claude-haiku-5-5');
    assert.equal(c.resolveTier('heavy').model, 'claude-opus-5-5');
    assert.equal(c.resolveTier('heavy').why, 'рекомендация');
});

test('own source and model per tier; model of another source comes from its SillyTavern field', () => {
    const c = client({ heavySource: 'deepseek', scan: 'my-model' }, st({ chat_completion_source: 'custom', custom_model: 'local', deepseek_model: 'deepseek-reasoner' }));
    assert.deepEqual([c.resolveTier('scan').source, c.resolveTier('scan').model], ['custom', 'my-model']);
    assert.deepEqual([c.resolveTier('heavy').source, c.resolveTier('heavy').model], ['deepseek', 'deepseek-reasoner']);
});

test('request body: OpenAI reasoning models get max_completion_tokens; proxy only for the source chosen in SillyTavern', () => {
    const c = client({ heavySource: 'openai', heavy: 'gpt-5.2', heavyEffort: 'high' }, st({ chat_completion_source: 'claude', reverse_proxy: 'http://proxy', proxy_password: 'p' }));
    const heavy = c.chatBody(c.resolveTier('heavy'), 'sys', 'user');
    assert.equal(heavy.max_tokens, undefined);
    assert.equal(heavy.max_completion_tokens, 8192);
    assert.equal(heavy.reasoning_effort, 'high');
    assert.equal(heavy.reverse_proxy, undefined);
    const scan = c.chatBody(c.resolveTier('scan'), 'sys', 'user');
    assert.equal(scan.reverse_proxy, 'http://proxy');
    assert.equal(scan.temperature, undefined);
});

test('Text Completion: model and server from SillyTavern, prompt from its instruct template', () => {
    const stSettings = {
        main_api: 'textgenerationwebui',
        oai_settings: {},
        textgenerationwebui_settings: { type: 'koboldcpp', server_urls: { koboldcpp: 'http://127.0.0.1:5001' } },
        power_user: { instruct: { enabled: true, wrap: true, system_sequence: '<|im_start|>system', system_suffix: '<|im_end|>\n', input_sequence: '<|im_start|>user', input_suffix: '<|im_end|>\n', output_sequence: '<|im_start|>assistant', stop_sequence: '<|im_end|>' } },
    };
    const c = client({}, stSettings);
    const r = c.resolveTier('scan');
    assert.equal(r.api, 'text');
    const body = c.textBody(r, 'SYS', 'USER');
    assert.equal(body.api_server, 'http://127.0.0.1:5001');
    assert.equal(body.prompt, '<|im_start|>system\nSYS<|im_end|>\n<|im_start|>user\nUSER<|im_end|>\n<|im_start|>assistant\n');
    assert.ok(body.stop.includes('<|im_end|>'));
});

test('instruct off and thinking tags', () => {
    assert.match(instructPrompt({ enabled: false }, 'S', 'U').prompt, /^S\n\nU/);
    assert.equal(stripThinking('<think>долго думаю</think>\nОтвет'), 'Ответ');
    assert.equal(stripThinking('мысли без начала</think>Ответ'), 'Ответ');
});
