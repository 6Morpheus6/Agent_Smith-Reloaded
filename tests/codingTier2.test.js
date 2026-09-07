const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vh = require('../src/shared/verificationHarness.js');
const editFormats = require('../src/shared/editFormats.js');
const memory = require('../src/main/services/memory.js');

function tmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xk-t2-'));
}

test('runVerification syntaxOnly: skips test/lint, still catches a syntax error', async () => {
    const d = tmpProject();
    fs.writeFileSync(path.join(d, 'ok.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(d, 'bad.js'), 'function (\n');

    const okPlan = { testCmd: 'exit 1', lintCmd: null, filesLedger: { 'ok.js': {} } };
    const okRes = await vh.runVerification(d, okPlan, { syntaxOnly: true });
    assert.equal(okRes.ok, true, 'syntaxOnly must not run failing testCmd');

    const badPlan = { testCmd: null, lintCmd: null, filesLedger: { 'bad.js': {} } };
    const badRes = await vh.runVerification(d, badPlan, { syntaxOnly: true });
    assert.equal(badRes.ok, false);
});

test('applySearchReplace exact match refuses multiple occurrences', () => {
    const content = 'foo bar foo bar';
    const r = editFormats.applySearchReplace(content, 'foo', 'baz');
    assert.ok(r.error && /multiple/i.test(r.error));
});

test('memory retrieval math: cosineSimilarity + filterByFloor actually rank/filter', () => {
    // Exercise the real retrieval primitives. The singleton query needs an embedding
    // backend that isn't available in tests (so it only hits {success:false}, proving
    // nothing); these are the pieces that decide what actually gets recalled.
    assert.equal(memory.cosineSimilarity([1, 0, 0], [1, 0, 0]), 1, 'identical → 1');
    assert.equal(memory.cosineSimilarity([1, 0], [0, 1]), 0, 'orthogonal → 0');
    const partial = memory.cosineSimilarity([1, 1], [1, 0]);
    assert.ok(partial > 0 && partial < 1);

    const ranked = [{ id: 'a', similarity: 0.9 }, { id: 'b', similarity: 0.05 }, { id: 'c', similarity: 0.5 }];
    const ids = memory.filterByFloor(ranked, 0.15).map(r => r.id);
    assert.ok(ids.includes('a') && ids.includes('c'), 'above-floor kept');
    assert.ok(!ids.includes('b'), 'sub-floor dropped');
});

test('memory queryVectors returns a structured {success} wrapper', async () => {
    const res = await memory.queryVectors('test query', 3);
    assert.equal(typeof res.success, 'boolean');
    if (!res.success) assert.ok('error' in res, 'failure path carries an error');
});
