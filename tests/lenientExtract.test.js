/**
 * Tolerant tool-call extraction. Reproduces the real failed run: the model emitted
 * several write_file calls concatenated as text, with UNESCAPED double-quotes in the HTML
 * content (id="game") and a truncated final call. Strict JSON.parse dropped them all, so
 * script.js was never written and the run looped. The lenient pass must recover the
 * complete calls (quotes preserved) and skip the truncated tail.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractFromMessage, extractLenientWriteCalls } = require('../src/code/tools/extractor.js');

const SCHEMAS = [{ function: { name: 'write_file' } }, { function: { name: 'patch' } }];

test('recovers concatenated write_file calls with unescaped quotes; skips truncated tail', () => {
    const content = [
        '{"name": "write_file", "parameters": {"path": "pacman/style.css", "content": "body { color: red; }"}}',
        '{"name": "write_file", "parameters": {"path": "pacman/index.html", "content": "<div id="game-container"></div><script src="script.js"></script>"}}',
        '{"name": "write_file", "parameters": {"path": "pacman/script.js", "content": "const MAZE = [1, 1, 1,'
    ].join('\n');

    const msg = { content };
    const r = extractFromMessage(msg, SCHEMAS);
    assert.ok(r.addedCalls >= 2, 'should recover at least the two complete calls');

    const paths = (msg.tool_calls || []).map(c => c.function.arguments.path);
    assert.ok(paths.includes('pacman/style.css'), 'clean call recovered');
    assert.ok(paths.includes('pacman/index.html'), 'unescaped-quote call recovered (was previously dropped)');
    assert.ok(!paths.includes('pacman/script.js'), 'truncated call skipped (never write a half file)');

    const html = msg.tool_calls.find(c => c.function.arguments.path === 'pacman/index.html');
    assert.match(html.function.arguments.content, /id="game-container"/, 'embedded quotes preserved');
    assert.match(html.function.arguments.content, /src="script\.js"/);
});

test('lenient pass decodes standard JSON escapes in content', () => {
    const calls = extractLenientWriteCalls(
        '{"name":"write_file","parameters":{"path":"a.js","content":"const x = 1;\\nconst y = \\"hi\\";\\n"}}',
        new Set(['write_file'])
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.arguments.content, 'const x = 1;\nconst y = "hi";\n');
});

test('lenient pass ignores non-content tools and unknown names', () => {
    const calls = extractLenientWriteCalls(
        '{"name":"run_command","parameters":{"command":"ls"}}{"name":"bogus","parameters":{"path":"x","content":"y"}}',
        new Set(['write_file', 'run_command'])
    );
    assert.equal(calls.length, 0, 'only write_file/patch with path+content are recovered here');
});
