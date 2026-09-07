/**
 * v52.6 — dsh-style tool execution pipeline (tools/pipeline.js).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    executionMode, finalizeResult, runToolPipeline, RESULT_SPILL_CHARS
} = require('../src/code/tools/pipeline.js');

test('executionMode: read-only tools are parallel, everything else exclusive (fail-closed)', () => {
    assert.equal(executionMode('read_file').kind, 'parallel');
    assert.equal(executionMode('grep').kind, 'parallel');
    assert.equal(executionMode('glob').kind, 'parallel');
    assert.equal(executionMode('list_project').kind, 'parallel');
    // Writes mutate files + the change ledger — exclusive.
    assert.equal(executionMode('write_file').kind, 'exclusive');
    assert.equal(executionMode('patch').kind, 'exclusive');
    assert.equal(executionMode('append_file').kind, 'exclusive');
    // Shell / preview / run_code (programs can write) — exclusive.
    assert.equal(executionMode('run_command').kind, 'exclusive');
    assert.equal(executionMode('show_preview').kind, 'exclusive');
    assert.equal(executionMode('run_code').kind, 'exclusive');
    // Unknown / undeclared / invalid → exclusive (dsh fail-closed).
    assert.equal(executionMode('some_plugin_tool').kind, 'exclusive');
    assert.equal(executionMode(undefined).kind, 'exclusive');
    assert.equal(executionMode(42).kind, 'exclusive');
});

test('pre-execute hook veto skips the body entirely', async () => {
    let bodyCalled = false;
    const out = await runToolPipeline({
        name: 'read_file',
        args: {},
        callId: 'c1',
        body: async () => { bodyCalled = true; return { ok: 1 }; },
        deps: {
            fireHook: async (event) => event === 'beforeToolCall' ? { blocked: true, reason: 'plugin says no' } : null
        }
    });
    assert.equal(bodyCalled, false);
    assert.match(out.error, /plugin says no/);
});

test('post-execute hook may replace the result', async () => {
    const out = await runToolPipeline({
        name: 'read_file',
        args: {},
        callId: 'c2',
        body: async () => ({ original: true }),
        deps: {
            fireHook: async (event) => event === 'afterToolCall' ? { __replaceResult: { replaced: true } } : null
        }
    });
    assert.equal(out.replaced, true);
    assert.ok(!('original' in out));
});

test('a throwing body is normalized into isError — the pipeline never rejects', async () => {
    const out = await runToolPipeline({
        name: 'read_file',
        args: {},
        callId: 'c3',
        body: async () => { throw new Error('disk on fire'); },
        deps: {}
    });
    assert.equal(out.isError, true);
    assert.match(out.error, /disk on fire/);
});

test('a throwing post-hook is contained — the original result survives', async () => {
    const out = await runToolPipeline({
        name: 'read_file',
        args: {},
        callId: 'c4',
        body: async () => ({ survived: true }),
        deps: { fireHook: async () => { throw new Error('bad subscriber'); } }
    });
    assert.equal(out.survived, true);
});

test('small results pass through with resultStr = lossless JSON', async () => {
    const out = await runToolPipeline({
        name: 'read_file',
        args: {},
        callId: 'c5',
        body: async () => ({ path: 'a.txt', content: 'hi' }),
        deps: {}
    });
    assert.equal(out.path, 'a.txt');
    assert.deepEqual(JSON.parse(out.resultStr), { path: 'a.txt', content: 'hi' });
});

test('oversized results are spilled to disk and replaced by head+tail window + path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v526-spill-'));
    try {
        const big = 'x'.repeat(RESULT_SPILL_CHARS + 10000);
        const out = await runToolPipeline({
            name: 'grep',
            args: {},
            callId: 'big_call_1',
            body: async () => ({ hits: [big] }),
            deps: { projectContext: { getRoot: () => root } }
        });
        assert.match(out.resultStr, /RESULT TRUNCATED/);
        assert.match(out.resultStr, /\.agentsmith\/tool-results\//);
        // The full payload is on disk.
        const spilled = fs.readdirSync(path.join(root, '.agentsmith/tool-results'));
        assert.equal(spilled.length, 1);
        const content = fs.readFileSync(path.join(root, '.agentsmith/tool-results', spilled[0]), 'utf-8');
        assert.ok(content.includes(big));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('finalizeResult is a no-op under the spill threshold', () => {
    const s = 'y'.repeat(RESULT_SPILL_CHARS);
    assert.equal(finalizeResult('c6', s), s);
});
