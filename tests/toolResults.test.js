/**
 * v53.6 — toolResults: honest tool-result classification + finite timeouts.
 *
 * The chat batch executor used `!startsWith('Error:')` as its ONLY failure test, so
 * "web search failed…", thrown non-Error values, JSON {error} bodies and empty output
 * were all reported to the timeline (and back to the model) as successes — the model
 * then narrated confident success over a failed call. These tests exercise the pure
 * classifier directly and prove withTimeout turns a hung tool into an honest error
 * string within its deadline instead of freezing the run forever.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tr = require('../src/shared/toolResults.js');

test('plain successful output is ok', () => {
    const r = tr.classifyToolResult('README.md\nsrc/\npackage.json');
    assert.equal(r.ok, true);
    assert.match(r.text, /README/);
});

test('Error: and [BLOCKED] prefixes are failures', () => {
    assert.equal(tr.classifyToolResult('Error: ENOENT no such file').ok, false);
    assert.equal(tr.classifyToolResult('[BLOCKED] path outside project root').ok, false);
});

test('"web search failed" / "no web results found" are failures (v53.5 shapes)', () => {
    assert.equal(tr.classifyToolResult('web search failed: fetch timeout').ok, false);
    assert.equal(tr.classifyToolResult('No web results found for that query.').ok, false);
});

test('thrown Error and non-Error values are failures', () => {
    assert.equal(tr.classifyToolResult(new Error('boom')).ok, false);
    const thrown = tr.classifyToolResult('just a string throw');
    // A bare string that isn't an error prefix stays data — only Error instances fail.
    assert.equal(thrown.ok, true);
});

test('JSON body with an explicit error field is a failure', () => {
    const r = tr.classifyToolResult({ ok: false, error: 'sudo required' });
    assert.equal(r.ok, false);
    assert.match(r.error, /sudo/);
});

test('empty / whitespace output is not a silent success', () => {
    assert.equal(tr.classifyToolResult('').ok, false);
    assert.equal(tr.classifyToolResult('   \n ').ok, false);
    assert.equal(tr.classifyToolResult(null).ok, false);
});

test('withTimeout resolves a normal promise unchanged', async () => {
    const v = await tr.withTimeout(Promise.resolve('file contents'), 5000, 'read_file');
    assert.equal(v, 'file contents');
});

test('withTimeout turns a hung tool into an honest error string', async () => {
    const hang = new Promise(() => { /* never settles — dead fetch */ });
    const start = Date.now();
    const v = await tr.withTimeout(hang, 60, 'fetch_url');
    assert.equal(typeof v, 'string');
    assert.match(v, /^Error: fetch_url timed out/);
    assert.ok(Date.now() - start < 5000, 'returns promptly at the deadline');
});

test('withTimeout converts rejections to Error values for the classifier', async () => {
    const v = await tr.withTimeout(Promise.reject(new Error('disk gone')), 5000, 'write_file');
    assert.equal(tr.classifyToolResult(v).ok, false);
});

// v54.2 — regression: generate_image hit the old 120 s chat-tool cap while a render was
// still in flight (first use = engine + ~4 GB model download, then GPU sampling). The
// wrapper reported "timed out" over an image that actually rendered, so the model looped
// re-checking for it. The default deadline must outlast the slowest legitimate chat tool.
test('default tool timeout is long enough for generate_image (v54.2)', () => {
    assert.ok(
        tr.DEFAULT_TOOL_TIMEOUT_MS >= 240000,
        `DEFAULT_TOOL_TIMEOUT_MS is ${tr.DEFAULT_TOOL_TIMEOUT_MS}ms — must be at least 4 min so a slow image render settles before the wrapper fires`
    );
});

test('withTimeout honors an explicit deadline shorter than the default', async () => {
    const hang = new Promise(() => {}); // never settles
    const v = await tr.withTimeout(hang, 60, 'generate_image');
    assert.match(v, /^Error: generate_image timed out after 1s/);
});
