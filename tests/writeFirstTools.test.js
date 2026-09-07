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
