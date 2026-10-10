// Write-first on an empty workspace: a greenfield build's first turn must offer only write
// tools (+ host-control tools in v50) — no read/grep/glob/list/preview of the project — so
// the model creates files instead of exploring an empty folder. The full toolset returns
// once a file exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectToolsForTurn } = require('../src/code/tools/router.js');
const { WRITE_FIRST_TOOLS, WRITE_OR_HOST, isGreenfieldWorkspace } = require('../src/code/loop/phases.js');

const names = (opts) => selectToolsForTurn(opts).map(t => t.function ? t.function.name : t.name);
const READONLY = ['read_file', 'grep', 'glob', 'list_project', 'show_preview'];

test('write-first turn offers only write + host tools', () => {
    const n = names({ phase: 'implement', writeOnly: true });
    assert.ok(n.includes('write_file'), 'write_file is offered');
    assert.ok(n.every(x => WRITE_OR_HOST.has(x)), 'only write+host tools: ' + n.join(','));
    for (const ro of READONLY) assert.ok(!n.includes(ro), `${ro} must NOT be offered on an empty turn 1`);
});

test('v54.7 — run_command IS offered on the write-first turn', () => {
    // "Build X AND package it" tasks need shell from turn one (env checks, scaffolding,
    // the packaging command itself). v53.7 added run_command to implement, but the
    // write-only filter dropped it again on empty-workspace turns — the model then stalled
    // and reported "can't find run_command". The original purpose of the filter (no
    // read/search/preview of an empty folder) is preserved: only shell joins.
    const n = names({ phase: 'implement', writeOnly: true });
    assert.ok(n.includes('run_command'), 'run_command must be offered on a write-first turn');
    for (const ro of READONLY) assert.ok(!n.includes(ro), `${ro} still withheld on an empty turn 1`);
});

test('v54.7 — run_code programs see run_command when it is offered', () => {
    // The run_code sub-tool surface mirrors the offered set (deps.offeredToolNames). A
    // write-first turn's program must be able to call tools.run_command; a tool that is
    // genuinely not offered still throws an actionable rejection, not "is not a function".
    const { createRunCodeExecutor } = require('../src/code/tools/runCode.js');
    const offered = names({ phase: 'implement', writeOnly: true });
    let dispatched = null;
    const executor = createRunCodeExecutor({
        session: { phase: 'implement' },
        offeredToolNames: offered,
        executeTool: async (name, args) => { dispatched = name; return { stdout: 'ok', exit_code: 0 }; }
    });
    return executor({ code: 'await tools.run_command({ command: "node --version" }); return "done";', description: 'Check node version' })
        .then(r => {
            assert.equal(dispatched, 'run_command', 'program sub-call reached the executor');
            assert.ok(!r.error, 'no error: ' + JSON.stringify(r));
        });
});

test('normal implement turn restores the full toolset (read/search/preview back)', () => {
    const n = names({ phase: 'implement', writeOnly: false });
    assert.ok(n.includes('read_file') && n.includes('grep') && n.includes('show_preview'));
    assert.ok(n.includes('write_file') && n.includes('patch'));
});

test('write-first also drops plugin tools; full turn keeps them', () => {
    const plugin = [{ type: 'function', function: { name: 'my_plugin_tool', parameters: { type: 'object' } } }];
    assert.ok(!names({ phase: 'implement', writeOnly: true, pluginToolSchemas: plugin }).includes('my_plugin_tool'));
    assert.ok(names({ phase: 'implement', writeOnly: false, pluginToolSchemas: plugin }).includes('my_plugin_tool'));
});

test('emptyWorkspace gating: empty dir is greenfield; a dir with files is not', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-empty-'));
    assert.equal(isGreenfieldWorkspace(empty, ''), true);
    const used = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-used-'));
    fs.writeFileSync(path.join(used, 'main.js'), 'x');
    assert.equal(isGreenfieldWorkspace(used, 'main.js\npackage.json\nsrc/'), false);
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(used, { recursive: true, force: true });
});
