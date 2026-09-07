/**
 * Runtime profile — model + hardware → recommended tuning for existing sliders.
 * Separate from readiness.js (project workspace) and gemmaHarness.js (prompt shape).
 *
 * Rule table (summary):
 * - VRAM tier sets context ceiling (low/medium/high/ultra)
 * - Larger param counts scale ceiling down (14B ~0.75x, 32B+ ~0.5x)
 * - Coder models: lower temp, more Code turns
 * - High VRAM pressure: drop one ctx tier + warning
 */
'use strict';

const { classifyModel } = require('./modelClassifier.js');

const CTX_STEP = 1024;
const CTX_MIN = 2048;
const CTX_MAX = 131072;

function vramTierFromTelemetry(telemetry) {
    const total = telemetry?.memory?.total;
    if (!Number.isFinite(total) || total <= 0) return 'medium';
    const gb = total / 1024;
    if (gb < 8) return 'low';
    if (gb < 16) return 'medium';
    if (gb < 24) return 'high';
    return 'ultra';
}

const TIER_CTX_CEILING = {
    low: 12288,
    medium: 24576,
    high: 49152,
    ultra: 131072
};

const TIER_DOWN = { ultra: 'high', high: 'medium', medium: 'low', low: 'low' };

function sizeScale(sizeB) {
    if (!sizeB || sizeB <= 7) return 1;
    if (sizeB <= 14) return 0.75;
    if (sizeB <= 32) return 0.55;
    return 0.45;
}

function snapCtx(n) {
    const v = Math.round(n / CTX_STEP) * CTX_STEP;
    return Math.min(CTX_MAX, Math.max(CTX_MIN, v));
}

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

/**
 * @param {{ modelId?: string, telemetry?: object, mode?: string }} opts
 * @returns {object} profile
 */
function buildRuntimeProfile(opts = {}) {
    const modelId = opts.modelId || '';
    const classifier = classifyModel(modelId);
    const warnings = [];
    let tier = vramTierFromTelemetry(opts.telemetry);

    if (opts.telemetry?.is_high_pressure) {
        tier = TIER_DOWN[tier];
        warnings.push('High VRAM pressure — reduced context ceiling.');
    }

    let numCtx = snapCtx(TIER_CTX_CEILING[tier] * sizeScale(classifier.sizeB));

    let temperature = 0.5;
    let codeTemperature = 0.2;
    let maxSteps = 20;
    let maxTurns = 40;

    if (classifier.isCoder) {
        temperature = 0.25;
        codeTemperature = 0.15;
        maxSteps = 25;
        maxTurns = 50;
        if (tier === 'low') {
            numCtx = snapCtx(Math.min(numCtx, 12288));
        }
    } else if (classifier.isReasoning) {
        temperature = 0.4;
        codeTemperature = 0.25;
        maxSteps = 30;
        maxTurns = 45;
    } else if (classifier.sizeB && classifier.sizeB >= 32) {
        temperature = 0.35;
        codeTemperature = 0.2;
        maxSteps = 20;
        maxTurns = 35;
        warnings.push('Large model — prefer shorter Code runs or enable GRIND for verification.');
    } else if (tier === 'low') {
        temperature = 0.5;
        codeTemperature = 0.2;
        maxSteps = 15;
        maxTurns = 40;
        numCtx = snapCtx(Math.min(numCtx, 8192));
    }

    if (!classifier.isCoder && !classifier.isReasoning) {
        warnings.push('General instruct model — a coder model is recommended for Code Mode builds.');
    }

    temperature = clamp(temperature, 0, 2);
    codeTemperature = clamp(codeTemperature, 0.1, 0.35);
    maxSteps = clamp(maxSteps, 5, 100);
    maxTurns = clamp(maxTurns, 20, 80);

    const vramGb = opts.telemetry?.memory?.total
        ? Math.round(opts.telemetry.memory.total / 1024)
        : null;
    const ctxK = Math.round(numCtx / 1024);
    const summaryParts = [classifier.label];
    if (vramGb) summaryParts.push(`${vramGb}GB VRAM`);
    summaryParts.push(`ctx ${ctxK}K`);

    return {
        numCtx,
        temperature,
        codeTemperature,
        maxSteps,
        maxTurns,
        summary: summaryParts.join(' · '),
        warnings,
        classifier,
        vramTier: tier
    };
}

const api = {
    buildRuntimeProfile,
    vramTierFromTelemetry,
    snapCtx,
    TIER_CTX_CEILING
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKRuntimeProfile = api;
