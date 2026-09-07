#!/usr/bin/env node
/**
 * Ship criteria smoke check (no LM Studio required).
 * Run: npm run ship-check
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
process.chdir(root);

console.log('Agent Smith Code Mode ship-check\n');

execSync('npm test', { stdio: 'inherit' });
execSync('npm run harness-eval-regression', { stdio: 'inherit' });
execSync('npm run harness-security', { stdio: 'inherit' });
if (process.argv.includes('--capability')) {
    execSync('npm run harness-eval-capability', { stdio: 'inherit' });
}

const { grepProject } = require('../src/shared/grepTool.js');
const { globFiles } = require('../src/shared/globTool.js');
const gitIntegration = require('../src/shared/gitIntegration.js');
const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const { executeTool } = require('../src/code/tools/executor.js');

async function brownfield() {
    const dir = path.join(os.tmpdir(), `xk-brown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bug.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 't', scripts: { test: 'node -e "process.exit(0)"' }
    }));
    projectContext.setRoot(dir);
    const g = await grepProject(dir, 'const x');
    if (!g.hits.length) throw new Error('brownfield grep failed');
    console.log('  brownfield grep: OK');
}

async function greenfield() {
    const dir = path.join(os.tmpdir(), `xk-green-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    await gitIntegration.init(dir);
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => 42;\n');
    fs.writeFileSync(path.join(dir, 'index.test.js'), 'const assert = require("assert");\nassert.strictEqual(require("./index.js")(), 42);\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'app', version: '1.0.0', scripts: { test: 'node index.test.js' }
    }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# App\n');
    const vh = require('../src/shared/verificationHarness.js');
    const plan = { testCmd: 'npm test', lintCmd: null, verifyPolicy: 'block', steps: [{ id: 1, verifiedAt: null }] };
    const v = await vh.runVerification(dir, plan);
    if (!v.ok) throw new Error('greenfield test failed: ' + v.messages);
    console.log('  greenfield scaffold+test: OK');
}

async function undo() {
    const dir = path.join(os.tmpdir(), `xk-undo-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    await gitIntegration.init(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    await gitIntegration.commit(dir, 'v1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
    const ledgerDir = path.join(dir, '.xk-user');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const ledger = new ChangeLedger(ledgerDir);
    const sessionId = 'code_undo_test';
    const editEngine = new EditEngine(ledger, projectContext);
    await editEngine.apply(sessionId, 'a.txt', 'v2', 'v1');
    await ledger.revertAll(sessionId);
    if (fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8') !== 'v2\n') throw new Error('ledger revert failed');
    console.log('  ledger revert: OK');
}

async function codeExecutorSmoke() {
    const dir = path.join(os.tmpdir(), `xk-code-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    const sessionId = 'ship_code';
    const deps = {
        sessionId,
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async (r, p) => grepProject(r, p),
        globFiles: async (r, p) => globFiles(r, p),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
    const w = await executeTool('write_file', { path: 'main.js', content: 'console.log(1);\n' }, deps);
    if (!w.success) throw new Error('write_file failed');
    const p = await executeTool('patch', { path: 'main.js', find: 'console.log(1)', replace: 'console.log(2)' }, deps);
    if (!p.success) throw new Error('patch failed');
    if (!p.fileDiff || !String(p.fileDiff).includes('+')) throw new Error('patch missing fileDiff');
    console.log('  code executor write+patch: OK');
}

async function activityTimelineSmoke() {
    require('../src/renderer/timeline/eventAdapter.js');
    require('../src/renderer/timeline/diffView.js');
    require('../src/renderer/timeline/activityTimeline.js');
    const { adaptCodeEvent } = require('../src/renderer/timeline/eventAdapter.js');
    const n = adaptCodeEvent({ type: 'tool_start', name: 'patch', args: { path: 'x' }, callId: 't1' });
    if (n.category !== 'write') throw new Error('adapter category failed');
    console.log('  activity timeline modules: OK');
}

async function codeSurfaceRouting() {
    const runUI = require('../src/renderer/ui/codeRunUI.js');
    if (runUI.routeEvent('tool_start') !== 'timeline') throw new Error('tool_start must route to timeline');
    if (runUI.routeEvent('done') !== 'code-panel') throw new Error('done must route to code-panel');
    console.log('  code surface routing: OK');
}

async function gemmaHarnessSmoke() {
    const gh = require('../src/code/context/gemmaHarness.js');
    const messages = [
        { role: 'system', content: 'SYS RULES' },
        { role: 'user', content: 'build it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
        { role: 'tool', name: 'read_file', content: 'body', tool_call_id: 'c1' }
    ];
    const out = gh.adaptMessagesForGemma(messages, 'gemma-3-4b-it', { toolNames: ['read_file', 'write_file'] });
    if (out.some(m => m.role === 'system')) throw new Error('gemma fold left a system role');
    if (out.some(m => m.role === 'tool')) throw new Error('gemma serialize left a tool role');
    if (!out[0].content.includes(gh.PREAMBLE_SENTINEL)) throw new Error('gemma preamble missing');
    console.log('  gemma harness: OK');
}

async function modeIsolationSmoke() {
    const rs = require('../src/renderer/modes/runState.js');
    if (!rs.chatRunState || !rs.codeRunState) throw new Error('separate run states missing');
    if (rs.chatRunState === rs.codeRunState) throw new Error('run states must not be shared');
    console.log('  mode isolation (runState): OK');
}

(async () => {
    await brownfield();
    await greenfield();
    await undo();
    await codeExecutorSmoke();
    await activityTimelineSmoke();
    await codeSurfaceRouting();
    await gemmaHarnessSmoke();
    await modeIsolationSmoke();
    execSync('node scripts/code-smoke.js', { stdio: 'inherit' });
    execSync('node scripts/greenfield-smoke.js', { stdio: 'inherit' });
    console.log('\nAll ship-check scenarios passed.');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
