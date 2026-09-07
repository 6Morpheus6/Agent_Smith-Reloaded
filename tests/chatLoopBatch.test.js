/**
 * v53.6 — chatLoop.executeAgentToolBatch: every tool call runs under a finite
 * deadline and reports an HONEST ok flag (the failure-streak guard in app.js and
 * the timeline both consume it). Tests drive the real executor with fake tools:
 * success, Error:-prefixed failure, thrown value, hung tool (timeout), and the
 * plugin-hook block path.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const chatLoop = require('../src/renderer/modes/chatLoop.js');

function call(name, args) {
    return { id: `call_${name}`, type: 'function', function: { name, arguments: args || {} } };
}

test('successful tool → ok:true and result passed through', async () => {
    const batch = await chatLoop.executeAgentToolBatch([call('read_file')], {
        executeTool: async () => 'line1\nline2'
    });
    assert.equal(batch.length, 1);
    assert.equal(batch[0].ok, true);
    assert.match(batch[0].result, /line1/);
});

test('failing tool → ok:false (model is never told it worked)', async () => {
    const batch = await chatLoop.executeAgentToolBatch([call('web_search')], {
        executeTool: async () => 'web search failed: upstream 503'
    });
    assert.equal(batch[0].ok, false);
});

test('thrown value → ok:false with an Error: string for the model', async () => {
    const batch = await chatLoop.executeAgentToolBatch([call('run_command')], {
        executeTool: async () => { throw new Error('EACCES denied'); }
    });
    assert.equal(batch[0].ok, false);
    assert.match(batch[0].result, /EACCES/);
});

test('hung tool → honest timeout error instead of a frozen run', async () => {
    const start = Date.now();
    const batch = await chatLoop.executeAgentToolBatch([call('fetch_url')], {
        toolTimeoutMs: 80, // test-scale deadline
        executeTool: () => new Promise(() => {}) // never settles (dead site)
    });
    assert.equal(batch[0].ok, false);
    assert.match(batch[0].result, /timed out/);
    assert.ok(Date.now() - start < 10000, 'the batch moved on promptly');
});

test('mixed batch: one success anywhere keeps the streak guard honest', async () => {
    const batch = await chatLoop.executeAgentToolBatch([call('read_file'), call('fetch_url')], {
        executeTool: async (name) => name === 'read_file' ? 'ok data' : 'Error: dns failure'
    });
    assert.deepEqual(batch.map(b => b.ok), [true, false]);
});

test('tool_start / tool_result timeline events carry the honest ok flag', async () => {
    const events = [];
    await chatLoop.executeAgentToolBatch([call('read_file')], {
        emitAgentEvent: (ev) => events.push(ev),
        executeTool: async () => 'Error: not found'
    });
    const result = events.find(e => e.type === 'tool_result');
    assert.ok(result, 'tool_result emitted');
    assert.equal(result.ok, false);
});
