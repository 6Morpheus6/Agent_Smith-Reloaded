const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildToolResponseFormat, parseConstrainedContent, FINISH_TOOL } = require('../src/code/loop/constrainTools.js');

const TOOLS = [
    { type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
];

test('buildToolResponseFormat makes a json_schema union pinning args per tool + a finish branch', () => {
    const rf = buildToolResponseFormat(TOOLS);
    assert.equal(rf.type, 'json_schema');
    assert.equal(rf.json_schema.strict, true);
    const branches = rf.json_schema.schema.oneOf;
    // 2 tools + 1 synthetic finish
    assert.equal(branches.length, 3);
    const names = branches.map(b => b.properties.name.const);
    assert.deepEqual(names.sort(), ['attempt_completion', 'read_file', 'write_file']);
    // write_file branch pins its own arguments schema
    const wf = branches.find(b => b.properties.name.const === 'write_file');
    assert.deepEqual(wf.properties.arguments.required, ['path', 'content']);
    assert.equal(wf.additionalProperties, false);
});

test('buildToolResponseFormat returns null when there are no tools', () => {
    assert.equal(buildToolResponseFormat([]), null);
    assert.equal(buildToolResponseFormat(null), null);
});

test('parseConstrainedContent turns a JSON tool object into a tool_calls array', () => {
    const r = parseConstrainedContent('{"name":"write_file","arguments":{"path":"a.js","content":"x"}}');
    assert.equal(r.finish, false);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].function.name, 'write_file');
    assert.deepEqual(r.toolCalls[0].function.arguments, { path: 'a.js', content: 'x' });
});

test('parseConstrainedContent recognizes the finish signal', () => {
    const r = parseConstrainedContent(`{"name":"${FINISH_TOOL}","arguments":{"summary":"all done"}}`);
    assert.equal(r.finish, true);
    assert.equal(r.summary, 'all done');
    assert.equal(r.toolCalls.length, 0);
});

test('parseConstrainedContent tolerates surrounding text / extracts the JSON block', () => {
    const r = parseConstrainedContent('sure: {"name":"read_file","arguments":{"path":"b.js"}} ');
    assert.equal(r.toolCalls[0].function.name, 'read_file');
});

test('parseConstrainedContent returns no tool call on garbage (no throw)', () => {
    const r = parseConstrainedContent('not json at all');
    assert.equal(r.toolCalls.length, 0);
    assert.equal(r.finish, false);
});
