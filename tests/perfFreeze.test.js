const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createThrottledRenderer } = require('../src/shared/renderThrottle.js');
const repoMap = require('../src/shared/repoMap.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- render throttle: bounds per-token re-render --------------------------

test('throttle: many rapid calls coalesce into few renders, latest value wins', async () => {
    let calls = 0, lastVal = null;
    const r = createThrottledRenderer((v) => { calls++; lastVal = v; }, 50);
    for (let i = 1; i <= 50; i++) r(i); // simulate 50 streamed tokens in one tick
    await sleep(80);
    r.flush();
    assert.ok(calls <= 3, `expected <=3 renders for 50 rapid calls, got ${calls}`);
    assert.strictEqual(lastVal, 50, 'the latest buffer is the one rendered');
});

test('throttle: flush renders immediately; cancel drops the pending render', async () => {
    let calls = 0, lastVal = null;
    const r = createThrottledRenderer((v) => { calls++; lastVal = v; }, 1000);
    r('a');
    r.flush();
    assert.strictEqual(calls, 1);
    assert.strictEqual(lastVal, 'a');
    r('b');
    r.cancel();
    await sleep(20);
    assert.strictEqual(calls, 1, 'cancel prevented the queued render');
});

// ---- repo map cache: no synchronous re-walk every turn ---------------------

function tmpProject() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-repomap-'));
    fs.writeFileSync(path.join(d, 'a.js'), 'export function foo(){}\n');
    fs.writeFileSync(path.join(d, 'b.js'), 'export const bar = 1;\n');
    return d;
}

test('repoMap: identical request within TTL is served from cache (no rebuild)', () => {
    repoMap.__clearCache();
    const root = tmpProject();
    const before = repoMap.__buildCount();
    const m1 = repoMap.buildRepoMap(root, { boostTerms: ['foo'] });
    const m2 = repoMap.buildRepoMap(root, { boostTerms: ['foo'] });
    assert.strictEqual(m1, m2);
    assert.strictEqual(repoMap.__buildCount() - before, 1, 'built once, second call cached');
});

test('repoMap: invalidate() forces a rebuild (after a file write)', () => {
    repoMap.__clearCache();
    const root = tmpProject();
    const before = repoMap.__buildCount();
    repoMap.buildRepoMap(root, { boostTerms: ['foo'] });
    repoMap.invalidate(root); // mimics a file write
    repoMap.buildRepoMap(root, { boostTerms: ['foo'] });
    assert.strictEqual(repoMap.__buildCount() - before, 2, 'rebuilt after invalidate');
});

test('repoMap: different boost terms are cached separately', () => {
    repoMap.__clearCache();
    const root = tmpProject();
    const before = repoMap.__buildCount();
    repoMap.buildRepoMap(root, { boostTerms: ['foo'] });
    repoMap.buildRepoMap(root, { boostTerms: ['bar'] });
    assert.strictEqual(repoMap.__buildCount() - before, 2, 'distinct boosts -> distinct builds');
});
