import path from 'node:path';
import { readJson } from './util.mjs';

// Reads SillyTavern's own settings.json (not secrets.json) to learn the
// connection the user picked and the context size.

export async function readStSettings(ctx) {
    return readJson(path.join(ctx.dirs.root, 'settings.json'), {});
}

const MODEL_FIELD = {
    claude: 'claude_model',
    openai: 'openai_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    openrouter: 'openrouter_model',
    ai21: 'ai21_model',
    mistralai: 'mistralai_model',
    custom: 'custom_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    siliconflow: 'siliconflow_model',
    minimax: 'minimax_model',
    electronhub: 'electronhub_model',
    chutes: 'chutes_model',
    nanogpt: 'nanogpt_model',
    deepseek: 'deepseek_model',
    aimlapi: 'aimlapi_model',
    xai: 'xai_model',
    pollinations: 'pollinations_model',
    cometapi: 'cometapi_model',
    moonshot: 'moonshot_model',
    fireworks: 'fireworks_model',
    azure_openai: 'azure_openai_model',
    zai: 'zai_model',
    workers_ai: 'workers_ai_model',
};

/** Model chosen in SillyTavern for a Chat Completion source. */
export function chatModelFor(stSettings, source) {
    const oai = stSettings?.oai_settings || {};
    const field = MODEL_FIELD[source];
    let model = field ? oai[field] : '';
    if (source === 'openrouter' && model === 'OR_Website') model = '';
    return model || '';
}

// Paid Text Completion services have fixed addresses; local ones come from server_urls.
const TEXTGEN_SERVERS = {
    featherless: 'https://api.featherless.ai/v1',
    mancer: 'https://neuro.mancer.tech',
    togetherai: 'https://api.together.xyz',
    infermaticai: 'https://api.totalgpt.ai',
    dreamgen: 'https://dreamgen.com',
    openrouter: 'https://openrouter.ai/api',
};

const TEXTGEN_MODEL_FIELD = {
    ooba: 'custom_model',
    generic: 'generic_model',
    mancer: 'mancer_model',
    togetherai: 'togetherai_model',
    infermaticai: 'infermaticai_model',
    dreamgen: 'dreamgen_model',
    openrouter: 'openrouter_model',
    vllm: 'vllm_model',
    aphrodite: 'aphrodite_model',
    ollama: 'ollama_model',
    featherless: 'featherless_model',
    tabby: 'tabby_model',
    llamacpp: 'llamacpp_model',
};

export function textgenInfo(stSettings) {
    const tg = stSettings?.textgenerationwebui_settings || {};
    const type = tg.type || '';
    const server = TEXTGEN_SERVERS[type] ?? tg.server_urls?.[type] ?? '';
    const model = type === 'huggingface' ? 'tgi' : (tg[TEXTGEN_MODEL_FIELD[type]] || '');
    return { type, server, model };
}

export function connectionInfo(stSettings) {
    const oai = stSettings?.oai_settings || {};
    const source = oai.chat_completion_source || '';
    const mainApi = stSettings?.main_api || 'openai';
    const isChatCompletion = mainApi === 'openai';
    const text = textgenInfo(stSettings);
    return {
        mainApi,
        // 'chat' = Chat Completion, 'text' = Text Completion, other APIs are not supported
        api: isChatCompletion ? 'chat' : mainApi === 'textgenerationwebui' ? 'text' : 'other',
        source,
        model: chatModelFor(stSettings, source),
        textType: text.type,
        textModel: text.model,
        contextSize: Number(isChatCompletion ? oai.openai_max_context : stSettings?.max_context) || 0,
        responseSize: Number(isChatCompletion ? oai.openai_max_tokens : stSettings?.amount_gen) || 0,
    };
}

export function globalWorlds(stSettings) {
    const list = stSettings?.world_info_settings?.world_info?.globalSelect;
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

export function extraCharWorlds(stSettings, avatar) {
    const list = stSettings?.world_info_settings?.world_info?.charLore;
    if (!Array.isArray(list)) return [];
    const found = list.find(item => item?.name === avatar);
    return Array.isArray(found?.extraBooks) ? found.extraBooks : [];
}

/** Body fields SillyTavern needs to reach the selected provider (proxy, custom URL, etc.). */
export function connectionBody(stSettings, source) {
    const oai = stSettings?.oai_settings || {};
    const body = {};
    const proxySources = ['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot'];
    // The reverse proxy in SillyTavern belongs to the source selected there, not to any other one.
    if (oai.reverse_proxy && proxySources.includes(source) && source === oai.chat_completion_source) {
        body.reverse_proxy = oai.reverse_proxy;
        body.proxy_password = oai.proxy_password;
    }
    switch (source) {
        case 'claude':
            body.use_sysprompt = true;
            break;
        case 'makersuite':
        case 'vertexai':
            body.use_sysprompt = true;
            if (source === 'vertexai') {
                body.vertexai_auth_mode = oai.vertexai_auth_mode;
                body.vertexai_region = oai.vertexai_region;
                body.vertexai_express_project_id = oai.vertexai_express_project_id;
            }
            break;
        case 'openrouter':
            body.use_fallback = oai.openrouter_use_fallback;
            body.provider = oai.openrouter_providers;
            body.quantizations = oai.openrouter_quantizations;
            body.allow_fallbacks = oai.openrouter_allow_fallbacks;
            body.middleout = oai.openrouter_middleout;
            break;
        case 'custom':
            body.custom_url = oai.custom_url;
            body.custom_include_body = oai.custom_include_body;
            body.custom_exclude_body = oai.custom_exclude_body;
            body.custom_include_headers = oai.custom_include_headers;
            break;
        case 'zai':
            body.zai_endpoint = oai.zai_endpoint;
            break;
        case 'siliconflow':
            body.siliconflow_endpoint = oai.siliconflow_endpoint;
            break;
        case 'minimax':
            body.minimax_endpoint = oai.minimax_endpoint;
            break;
        case 'pollinations':
            body.pollinations_endpoint = oai.pollinations_endpoint;
            break;
        case 'nanogpt':
            body.nanogpt_provider = oai.nanogpt_provider;
            break;
        case 'workers_ai':
            body.workers_ai_account_id = oai.workers_ai_account_id;
            break;
        case 'azure_openai':
            body.azure_base_url = oai.azure_base_url;
            body.azure_deployment_name = oai.azure_deployment_name;
            body.azure_api_version = oai.azure_api_version;
            break;
        default:
            break;
    }
    return body;
}
