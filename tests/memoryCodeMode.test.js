/**
 * Vector memory wired into Code Mode: relevant prior-run notes are recalled into the
 * first prompt, and a completed run is remembered for future recall. Both degrade
 * silently when memory is absent. Uses an injected stream (no live LLM).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCodeTask } = require('../src/code/loop/runCodeTask.js');
const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

function realExecDeps(root) {
    const ledger = new ChangeLedger(path.join(root, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    return {
        projectContext, editEngine, changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(root, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: '', stderr: '', error: null }),
        runBackgroundCommand: async () => ({ stdout: 'bg', jobId: 1 })
    };
}

test('recall injects prior-session memory into the first prompt', async () => {
    const root = tmp('mem-recall-'); const ud = tmp('mem-ud-');
    projectContext.setRoot(root);
    const memory = {
        recall: async () => ['Earlier in this project we used a 19x21 maze for the Pac-Man grid.'],
        remember: async () => {}
    };
    const stream = async () => ({ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' });

    const session = await runCodeTask({
        prompt: 'Build a web based Pac-Man game', projectRoot: root, model: 'qwen', numCtx: 8192,
        apiBaseUrl: 'http://x', userDataPath: ud, projectContext, execDeps: realExecDeps(root),
        emit: () => {}, streamCompletion: stream, memory, maxTurns: 6
    });

    const firstUser = session.messages.find(m => m.role === 'user');
    assert.match(firstUser.content, /RELEVANT MEMORY/);
    assert.match(firstUser.content, /19x21 maze/);
});

test('remember is called on completion when files were produced', async () => {
    const root = tmp('mem-remember-'); const ud = tmp('mem-ud2-');
    projectContext.setRoot(root);
    const remembered = [];
    const memory = { recall: async () => [], remember: async (text, meta) => remembered.push({ text, meta }) };

    let turn = 0;
    const stream = async () => {
        turn++;
        if (turn === 1) {
            return {
                message: {
                    role: 'assistant', content: '',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: { path: 'util.js', content: 'const x = 1;\n' } } }]
                },
                finishReason: 'tool_calls'
            };
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
    };

    const session = await runCodeTask({
        prompt: 'Build a utility script module', projectRoot: root, model: 'qwen', numCtx: 8192,
        apiBaseUrl: 'http://x', userDataPath: ud, projectContext, execDeps: realExecDeps(root),
        emit: () => {}, streamCompletion: stream, memory, maxTurns: 6
    });

    assert.ok(session.filesTouched.includes('util.js'), 'file was written');
    assert.ok(remembered.length >= 1, 'remember called on completion');
    assert.match(remembered[0].text, /util\.js/);
    assert.equal(remembered[0].meta.kind, 'code-run');
});

test('runs fine with no memory configured (graceful degradation)', async () => {
    const root = tmp('mem-none-'); const ud = tmp('mem-ud3-');
    projectContext.setRoot(root);
    const stream = async () => ({ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' });
    const session = await runCodeTask({
        prompt: 'Add a small utility script', projectRoot: root, model: 'qwen', numCtx: 8192,
        apiBaseUrl: 'http://x', userDataPath: ud, projectContext, execDeps: realExecDeps(root),
        emit: () => {}, streamCompletion: stream, maxTurns: 4
    });
    // Must reach a real terminal state, not hang in 'running'. (Old assert: ok(session.status)
    // passed for any truthy string, including a stuck 'running'.)
    assert.ok(['done', 'incomplete', 'unverified'].includes(session.status),
        'reached a terminal state, got: ' + session.status);
});
