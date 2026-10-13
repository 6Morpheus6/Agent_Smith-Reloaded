/**
 * v56.0.1 live E2E — typed custom-context field, end to end against REAL LM Studio.
 *
 * Drives the exact code path the new APPLY button invokes (renderer applyCtx → IPC
 * lmstudio-ensure-model → lmStudioManager.ensureModel) with a TYPED value, using only
 * gemma4-12b-qat-uncensored-hauhaucs-balanced (small resources, per user constraint).
 *
 * Steps:
 *   1. ensureModel(ctx=32768)  → loads gemma at exactly 32768 (fresh load).
 *   2. ensureModel(ctx=49152)  → the "user typed a new value" case: unload + reload at 49152.
 *   3. ensureModel(ctx=49152) again → no-op (already at/above requested — v55.9.2 contract).
 *   4. Verify via /api/v0/models that loaded_context_length == 49152.
 *   5. Cleanup: unload gemma so the user's own model state is untouched.
 */
'use strict';

const { createLmStudioManager } = require('../src/main/services/lmStudioManager.js');

const MODEL = 'gemma4-12b-qat-uncensored-hauhaucs-balanced';
const BASE = 'http://localhost:1234';
const mgr = createLmStudioManager(); // real deps: http + lms CLI

function loadedCtxViaApi() {
    return new Promise((resolve, reject) => {
        const http = require('http');
        http.get(`${BASE}/api/v0/models`, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                try {
                    const m = JSON.parse(body).data.find((x) => x.id === MODEL);
                    resolve(m ? m.loaded_context_length : null);
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

(async () => {
    const t0 = Date.now();
    console.log(`[1] ensureModel ctx=32768 (fresh load of ${MODEL})`);
    const r1 = await mgr.ensureModel({ apiBaseUrl: BASE, model: MODEL, contextLength: 32768 });
    console.log('   →', JSON.stringify(r1));
    if (!r1.managed || r1.loadedContext !== 32768) throw new Error(`step1 failed: ${JSON.stringify(r1)}`);

    console.log('[2] ensureModel ctx=49152 (user typed a NEW value → reload at exactly that window)');
    const t1 = Date.now();
    const r2 = await mgr.ensureModel({ apiBaseUrl: BASE, model: MODEL, contextLength: 49152 });
    console.log(`   → ${JSON.stringify(r2)} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    if (!r2.managed || r2.loadedContext !== 49152 || !r2.reloaded) throw new Error(`step2 failed: ${JSON.stringify(r2)}`);

    console.log('[3] ensureModel ctx=49152 again (already at requested → must be a no-op, no reload)');
    const r3 = await mgr.ensureModel({ apiBaseUrl: BASE, model: MODEL, contextLength: 49152 });
    console.log('   →', JSON.stringify(r3));
    if (!r3.managed || r3.loadedContext !== 49152 || r3.reloaded !== false) throw new Error(`step3 failed: ${JSON.stringify(r3)}`);

    const apiCtx = await loadedCtxViaApi();
    console.log('[4] /api/v0/models says loaded_context_length =', apiCtx);
    if (apiCtx !== 49152) throw new Error(`step4 failed: API reports ${apiCtx}, expected 49152`);

    // Cleanup — leave the user's LM Studio as we found it (gemma unloaded, their model untouched).
    console.log('[5] cleanup: unloading', MODEL);
    const { execFileSync } = require('child_process');
    try { execFileSync('/home/legend/.lmstudio/bin/lms', ['unload', MODEL], { stdio: 'pipe' }); console.log('   unloaded.'); } catch (e) { console.log('   unload note:', e.message); }

    console.log(`\nPASS — typed custom ctx applied via real LM Studio reload. total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error('\nFAIL —', e.message); process.exit(1); });
