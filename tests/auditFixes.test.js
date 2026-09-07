/**
 * Regression tests for the P1/P2 fixes from the full harness audit:
 * router never starves the model of plugin tools, undefined-const detection no longer
 * false-positives on member access / destructuring, and the verification gate is traced.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { selectToolsForTurn } = require('../src/code/tools/router.js');
const wv = require('../src/code/governor/webValidators.js');
const { CodeRunTrace } = require('../src/code/loop/codeTrace.js');

test('router never evicts phase tools (write_file/patch survive even with plugin names present)', () => {
    // Before the fix, the maxTools=7 slice could drop write_file/patch when plugin
    // names were appended — leaving the model unable to write. Phase tools must persist.
    const plugins = ['plugin_a', 'plugin_b', 'plugin_c', 'plugin_d'];
    const tools = selectToolsForTurn({ phase: 'implement', pluginToolNames: plugins, turnIndex: 5 });
    const names = tools.map(t => t.function.name);
    for (const t of ['read_file', 'grep', 'glob', 'list_project', 'write_file', 'append_file', 'patch']) {
        assert.ok(names.includes(t), `phase tool ${t} must be present`);
    }
});

test('findUndefinedConstants does not flag member access or destructured constants', () => {
    const js = `
        const Config = { MAX_SPEED: 5 };
        const { WIDTH, HEIGHT } = dims;
        let x = Config.MAX_SPEED + WIDTH + HEIGHT;
        const COLORS = { RED: '#f00' };
        ctx.fillStyle = COLORS.RED;
    `;
    const issues = wv.findUndefinedConstants(js);
    assert.equal(issues.length, 0, 'no false positives; got: ' + JSON.stringify(issues));
});

test('findUndefinedConstants still catches a genuinely undefined constant', () => {
    const js = 'const CELL = 24;\nconst w = CELL * GRID_SIZE;';
    const issues = wv.findUndefinedConstants(js);
    assert.ok(issues.some(i => /GRID_SIZE/.test(i.message)));
});

test('CodeRunTrace records the verification gate as a verify step', () => {
    const t = new CodeRunTrace('run_test');
    t.verifyBlocked('[WEB] script.js missing', 1);
    t.verifyGate('incomplete', '[WEB] script.js missing');
    const stages = t.trace.steps.map(s => s.stage);
    assert.ok(stages.includes('verify.blocked'));
    assert.ok(stages.includes('verify.gate'));
});
