/**
 * Agent Mode regression: `agent-list-directory` must return `files` as an ARRAY, because
 * the renderer dispatcher does `(res.files || []).join('\n')`. A pre-joined string made
 * that throw "res.files.join is not a function", killing the list_directory tool in Agent
 * Mode. (Sibling tools agent-glob/agent-grep already return arrays.)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');

const registerAgentIpc = require('../src/main/ipc/agent.js');
const projectContext = require('../src/main/services/projectContext.js');

test('agent-list-directory returns an array the renderer can .join()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lsdir-'));
    fs.writeFileSync(path.join(dir, 'alpha.txt'), 'a');
    fs.mkdirSync(path.join(dir, 'sub'));
    projectContext.setRoot(dir);

    const handlers = new Map();
    registerAgentIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
        fs, fsPromises, path, projectContext, spawn: () => {}, exec: () => {},
        state: { currentPlanId: null }, changeLedger: {}
    });

    const handler = handlers.get('agent-list-directory');
    assert.ok(handler, 'agent-list-directory handler registered');

    const res = await handler({}, '.');
    assert.equal(res.error, undefined, 'no error: ' + res.error);
    assert.ok(Array.isArray(res.files), 'files MUST be an array (renderer calls .join on it)');

    // Reproduce the renderer contract exactly — this used to throw on a string.
    const rendered = (res.files || []).join('\n') || '(empty directory)';
    assert.match(rendered, /alpha\.txt/);
    assert.match(rendered, /\[DIR\]\s+sub/);
});
