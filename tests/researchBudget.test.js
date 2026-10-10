/**
 * v55.8 — LIMITLESS RESEARCH BUDGET: deep-research runs must never die on their own findings.
 *
 * The reported failure (qwen3.8-27b-obliterated via LM Studio): the search tool's budget burned
 * out before the model finished, and the run ended with "Compiled from the search results above —
 * … these are the findings verbatim" — a forced regurgitation, not Smith's answer.
 *
 * Two root causes, two fixes (this file pins both):
 *   1. contextPrune crushed the deep-research report to MAX_TOOL_CHARS (1600) before the model
 *      ever saw it → the nudge demanded a 1500+ word synthesis of a ~1.6k-char fragment, so the
 *      reply burned its whole output budget on reasoning and fell into the fallback.
 *      FIX: reports in the recent window pass through verbatim (covered in contextPrune.test.js).
 *   2. When the prompt outgrew LM Studio's loaded context window mid-run, the run threw a
 *      "lower your context slider" error — the budget was hard-capped by the loaded instance.
 *      FIX: on a mid-run overflow the app auto-expands LM Studio to the model's MAXIMUM context
 *      (one-shot per run) and retries the turn — the research budget is effectively limitless.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

test('wiring: per-run one-shot auto-expand flag exists in the run loop', () => {
    assert.match(appSrc, /let ctxAutoExpanded = false;/);
});

test('wiring: mid-run context overflow triggers an expand-to-max + retry (not a hard error)', () => {
    const idx = appSrc.indexOf('classified.isContextOverflow && !ctxAutoExpanded');
    assert.ok(idx > 0, 'overflow branch must gate on the one-shot flag');
    const block = appSrc.slice(idx, idx + 2600);
    // Ask LM Studio for the model's real maximum…
    assert.match(block, /lmstudio-get-status/);
    assert.match(block, /st\.maxContext/);
    // …then reload at that maximum…
    assert.match(block, /lmstudio-ensure-model/);
    assert.match(block, /contextLength: maxCtx/);
    // …mark the run as expanded (one-shot — never loop)…
    assert.match(block, /ctxAutoExpanded = true;/);
    // …and retry the SAME turn with the full window.
    assert.match(block, /continue; \/\/ same turn, fresh request/);
});

test('wiring: when there is no room to grow, the honest error still surfaces (no silent loop)', () => {
    const idx = appSrc.indexOf('classified.isContextOverflow && !ctxAutoExpanded');
    assert.ok(idx > 0);
    // The expand branch must end by falling through to the classified-error throw that follows it.
    const block = appSrc.slice(idx, idx + 4500);
    assert.match(block, /if \(classified && classified\.message\) throw new Error\(classified\.message\);/);
});

test('wiring: the swap-handled marker suppresses the redundant 10s context re-sync after auto-expand', () => {
    const idx = appSrc.indexOf('classified.isContextOverflow && !ctxAutoExpanded');
    assert.ok(idx > 0);
    const block = appSrc.slice(idx, idx + 2600);
    assert.match(block, /markSwapHandled/);
});

test('wiring: the regurgitation footer is gone from the fallback synthesizer', () => {
    const fbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modes', 'webSearchFallback.js'), 'utf8');
    assert.doesNotMatch(fbSrc, /Compiled from the search results above/);
});

test('wiring: contextPrune exempts deep-research reports from the size cap (module-level)', () => {
    const prune = require('../src/shared/contextPrune.js');
    assert.equal(typeof prune.isDeepResearchReport, 'function', 'exemption helper exported');
    // A 60k-char report in the recent window survives byte-for-byte.
    const report = 'DEEP RESEARCH REPORT — "q"\nSOURCE 1: T\nURL: https://example.com/p\nWHAT I LEARNED FROM THIS PAGE:\n' + 'word '.repeat(9000);
    assert.ok(report.length > 45000);
    const out = prune.pruneChatHistory([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'research it' },
        { role: 'assistant', content: '', tool_calls: [{}] },
        { role: 'tool', name: 'web_search', content: report }
    ]);
    assert.equal(out[3].content, report);
});
