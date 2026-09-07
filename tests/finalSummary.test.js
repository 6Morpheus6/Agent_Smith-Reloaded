/**
 * Final-answer rendering tests. The user must never see raw tool JSON / turn logs, and
 * the verdict must reflect the validator results — not a model assertion of success.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFinalSummary, sanitizeAssistantText, stripToolJsonObjects } = require('../src/code/loop/finalSummary.js');

test('sanitizeAssistantText strips bare tool-call JSON', () => {
    const dirty = 'Done!\n{"name": "write_file", "parameters": {"path": "script.js", "content": "....."}}\nThanks';
    const clean = sanitizeAssistantText(dirty);
    assert.ok(!/write_file/.test(clean));
    assert.ok(!/parameters/.test(clean));
    assert.match(clean, /Done!/);
    assert.match(clean, /Thanks/);
});

test('sanitizeAssistantText strips serialized Gemma tool history + tool_call tags', () => {
    const dirty = 'Summary line\nInvoking tool `write_file` produced:\n{"success":true}\n<tool_call>{"name":"read_file"}</tool_call>';
    const clean = sanitizeAssistantText(dirty);
    assert.ok(!/Invoking tool/.test(clean));
    assert.ok(!/tool_call/.test(clean));
    assert.match(clean, /Summary line/);
});

test('stripToolJsonObjects leaves ordinary prose JSON-free but intact', () => {
    assert.equal(stripToolJsonObjects('hello world'), 'hello world');
});

test('buildFinalSummary marks INCOMPLETE when validation has messages', () => {
    const s = buildFinalSummary({
        status: 'incomplete',
        goal: 'Build a web based Pac-Man game',
        filesTouched: ['index.html', 'style.css', 'script.js'],
        validation: { messages: ['[SELECTOR] CSS selector `pacman` should be `.pacman`'], ranChecks: 5 },
        acceptance: { applicable: true, checks: [{ label: 'score updates', present: false }], failed: [{ label: 'score updates' }] },
        smoke: { skipped: false, engine: 'vm', ok: false, errors: ['script.js: SyntaxError: ...'] },
        exitReason: 'reflection budget exhausted'
    });
    assert.match(s, /INCOMPLETE/);
    assert.match(s, /\.pacman/);
    assert.ok(!/write_file/.test(s));
    assert.ok(!/\{"name"/.test(s));
    assert.match(s, /Not reported as success/);
});

test('buildFinalSummary marks COMPLETE only when clean', () => {
    const s = buildFinalSummary({
        status: 'done',
        goal: 'Build a web based Pac-Man game',
        filesTouched: ['index.html', 'style.css', 'script.js'],
        validation: { messages: [], ranChecks: 7 },
        acceptance: { applicable: true, checks: [{ label: 'player element renders', present: true }] },
        smoke: { skipped: false, engine: 'vm', ok: true, errors: [] }
    });
    assert.match(s, /COMPLETE \(verified\)/);
    assert.match(s, /verified/);
});
