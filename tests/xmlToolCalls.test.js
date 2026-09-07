'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const agentTools = require(path.resolve(__dirname, '../src/renderer/modes/agentTools.js'));
const { extractTextToolCalls } = agentTools;
const known = agentTools.AGENT_SYS_TOOLS.map(t => t.function.name);

// These are verbatim shapes qwen3-coder:30b emitted via Ollama that the old
// JSON-only fallback dropped — the model narrated the action, nothing ran.
test('parses Qwen XML run_shell_command call', () => {
    const text = "I'll find the kernel. <function=run_shell_command> <parameter=command> uname -r </parameter> </function>";
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'run_shell_command');
    assert.equal(calls[0].arguments.command, 'uname -r');
});

test('parses Qwen XML grep_project call', () => {
    const text = "<function=grep_project> <parameter=pattern> SPARROW42 </parameter> </function>";
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'grep_project');
    assert.equal(calls[0].arguments.pattern, 'SPARROW42');
});

test('coerces XML param types (int + bool)', () => {
    const text = '<function=run_shell_command><parameter=command>sleep 8</parameter><parameter=is_background>true</parameter></function>';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].arguments.is_background, true);
});

test('multiline XML body is preserved verbatim', () => {
    const text = '<function=write_file>\n<parameter=filepath>a.txt</parameter>\n<parameter=content>line1\nline2</parameter>\n</function>';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.filepath, 'a.txt');
    assert.equal(calls[0].arguments.content, 'line1\nline2');
});

test('still parses JSON-style fallback (no regression)', () => {
    const text = 'Sure. {"name":"read_file","parameters":{"filepath":"data.txt"}}';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read_file');
    assert.equal(calls[0].arguments.filepath, 'data.txt');
});

test('mixed JSON + XML in one message both recovered, deduped', () => {
    const text = '{"name":"read_file","parameters":{"filepath":"x"}} then <function=run_shell_command><parameter=command>ls</parameter></function> and a dup <function=read_file><parameter=filepath>x</parameter></function>';
    const calls = extractTextToolCalls(text, known);
    const names = calls.map(c => c.name).sort();
    assert.deepEqual(names, ['read_file', 'run_shell_command']);
});

test('unknown tool names in XML are ignored', () => {
    const text = '<function=definitely_not_a_tool><parameter=x>1</parameter></function>';
    assert.equal(extractTextToolCalls(text, known).length, 0);
});

// --- malformed-JSON tool-call repair (nested unescaped quotes in a shell command) ---
// gemma-4-26b emitted this verbatim: a raw-JSON-in-prose call whose `command` value
// contained unescaped inner quotes, so strict JSON.parse failed and the call was dropped.
test('recovers a tool call whose string value has unescaped inner quotes', () => {
    const text = 'Sure. {"name": "run_shell_command", "parameters": {"command": "echo "42.2" > km.txt"}}';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'run_shell_command');
    assert.equal(calls[0].arguments.command, 'echo "42.2" > km.txt');
});

test('repair does not fire for malformed JSON with an unknown tool name', () => {
    const text = '{"name": "definitely_not_a_tool", "parameters": {"command": "echo "x" > y"}}';
    assert.equal(extractTextToolCalls(text, known).length, 0);
});

test('well-formed JSON tool calls are unaffected by the repair path', () => {
    const text = '{"name":"write_file","parameters":{"filepath":"a.txt","content":"hi"}}';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.content, 'hi');
});
