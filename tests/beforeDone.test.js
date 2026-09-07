const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runMiddlewareChain } = require('../src/code/loop/middleware.js');
const { checkCompletion, formatBeforeDoneMessage } = require('../src/code/governor/completionGate.js');

test('beforeDone middleware veto blocks via messages', async () => {
    const custom = [{
        name: 'testBeforeDone',
        async beforeDone() {
            return { veto: true, messages: ['Tests must pass first'] };
        }
    }];
    const veto = await runMiddlewareChain(custom, 'beforeDone', {
        ctx: {},
        session: { filesTouched: ['a.js'], goal: 'test' },
        payload: { filesTouched: ['a.js'], goal: 'test' }
    });
    assert.equal(veto.veto, true);
    assert.deepEqual(veto.messages, ['Tests must pass first']);
});

test('formatBeforeDoneMessage includes hook reason', () => {
    const msg = formatBeforeDoneMessage(['custom check failed']);
    assert.match(msg, /beforeDone hook/);
    assert.match(msg, /custom check failed/);
});

test('grindMode blocks completion when test command fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grind-fail-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'grind-test',
        scripts: {
            test: 'node -e "process.exit(1)"',
            lint: 'node -e "process.exit(0)"'
        }
    }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};\n');

    const gate = await checkCompletion(root, ['index.js'], 'add module', {
        grindMode: true,
        projectMeta: { lintCmd: 'npm run lint', testCmd: 'npm test' }
    });
    assert.equal(gate.allow, false);
    assert.equal(gate.grindBlocked, true);
    assert.ok(gate.messages.some(m => /\[TEST FAILED\]/.test(m)));
});

test('grindMode off skips lint test gate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grind-off-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'grind-off',
        scripts: { test: 'node -e "process.exit(1)"' }
    }));
    fs.writeFileSync(path.join(root, 'helper.js'), 'export default 1;\n'.replace('export default 1;', 'module.exports = 1;'));

    const gate = await checkCompletion(root, ['helper.js'], 'chat only question', {
        grindMode: false,
        projectMeta: { testCmd: 'npm test' }
    });
    assert.equal(gate.allow, true);
});
