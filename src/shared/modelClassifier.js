/**
 * Model id classifier for runtime auto-tune.
 * Describes the loaded LM Studio model from its id string — does not adapt prompts
 * (see gemmaHarness.js for that).
 */
'use strict';

const FAMILY_PATTERNS = [
    ['gemma', /gemma/i],
    ['qwen', /qwen/i],
    ['llama', /llama|meta-llama/i],
    ['deepseek', /deepseek/i],
    ['mistral', /mistral|mixtral/i],
    ['phi', /phi-?\d/i],
    ['codestral', /codestral/i]
];

const SIZE_PATTERN = /(?:^|[^0-9])(\d+(?:\.\d+)?)\s*b(?:illion)?(?:[^0-9]|$)/i;

function detectFamily(id) {
    const s = String(id || '');
    for (const [name, re] of FAMILY_PATTERNS) {
        if (re.test(s)) return name;
    }
    return 'unknown';
}

function detectSizeB(id) {
    const m = String(id || '').match(SIZE_PATTERN);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 60) return 70;
    if (n >= 28) return 32;
    if (n >= 11) return 14;
    if (n >= 6) return 7;
    return Math.round(n);
}

function detectCoder(id) {
    return /\b(coder|code|codestral)\b/i.test(String(id || ''));
}

// Kimi K3 (Moonshot) is a thinking model whose API rejects any temperature but 1
// ("invalid temperature: only 1 is allowed for this model"). Callers that build a
// request body must pin temperature to 1 for these ids. Other Kimi models
// (kimi-k2.x etc.) accept a normal temperature range and are NOT matched.
function isKimiK3Model(id) {
    return /\bkimi[-_.]?k3\b/i.test(String(id || ''));
}

// Qwen 3-and-newer ids (qwen3, qwen-3.8, "Qwen3-Coder", …). The Qwen3 family ships a
// hybrid thinking template that THOUGHT-BY-DEFAULT: every reply starts with internal
// reasoning tokens and can exhaust the whole output budget before emitting any content
// or tool call (finish_reason:"length", empty message — the v51.2 "crash after plan
// approval" symptom). Qwen 2.x ids do NOT match and keep the default strategy.
function isQwenThinkingModel(id) {
    return /qwen[-_. ]?3(\.\d+)*/i.test(String(id || ''));
}

function detectReasoning(id) {
    return /\b(r1|reasoning|reason|think|o1|o3)\b/i.test(String(id || ''));
}

function buildLabel(family, sizeB, isCoder, isReasoning) {
    const parts = [];
    if (sizeB) parts.push(`${sizeB}B`);
    if (family !== 'unknown') parts.push(family);
    if (isCoder) parts.push('coder');
    else if (isReasoning) parts.push('reasoning');
    else parts.push('instruct');
    return parts.join(' ');
}

/**
 * @param {string} modelId
 * @returns {{ family: string, sizeB: number|null, isCoder: boolean, isReasoning: boolean, label: string }}
 */
function classifyModel(modelId) {
    const family = detectFamily(modelId);
    const sizeB = detectSizeB(modelId);
    const isCoder = detectCoder(modelId);
    const isReasoning = detectReasoning(modelId);
    return {
        family,
        sizeB,
        isCoder,
        isReasoning,
        label: buildLabel(family, sizeB, isCoder, isReasoning)
    };
}

const api = {
    classifyModel,
    detectFamily,
    detectSizeB,
    isKimiK3Model,
    isQwenThinkingModel,
    detectCoder,
    detectReasoning
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKModelClassifier = api;
