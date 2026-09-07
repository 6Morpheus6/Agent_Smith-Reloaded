'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { repairJsonControlChars, tryParseJson } = require('../src/code/tools/jsonRepair.js');
const { extractFromMessage } = require('../src/code/tools/extractor.js');

test('repairJsonControlChars escapes raw newlines inside string values', () => {
    const broken = '{"content": "const x=1;\nconst y=2;"}';
    const fixed = repairJsonControlChars(broken);
    const obj = JSON.parse(fixed);
    assert.strictEqual(obj.content, 'const x=1;\nconst y=2;');
});

test('repairJsonControlChars leaves already-valid JSON untouched', () => {
    const valid = JSON.stringify({ a: 'line1\nline2', b: [1, 2, 3] });
    assert.strictEqual(repairJsonControlChars(valid), valid);
});

test('repairJsonControlChars does not touch braces/newlines outside strings', () => {
    const src = '{\n  "a": 1\n}';
    assert.strictEqual(repairJsonControlChars(src), src);
});

test('tryParseJson recovers from raw control chars', () => {
    const r = tryParseJson('{"content": "a\nb\tc"}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.content, 'a\nb\tc');
});

test('extractor recovers a write_file emitted as text with raw newlines in content', () => {
    const raw = '{"name": "write_file", "parameters": {"path": "pacman/script.js", "content": "const x=1;\nconst y=2;"}}';
    const msg = { content: raw };
    const r = extractFromMessage(msg, [{ function: { name: 'write_file' } }]);
    assert.strictEqual(r.addedCalls, 1);
    assert.strictEqual(msg.tool_calls[0].function.name, 'write_file');
    assert.strictEqual(msg.tool_calls[0].function.arguments.path, 'pacman/script.js');
    assert.match(msg.tool_calls[0].function.arguments.content, /const x=1;/);
});
