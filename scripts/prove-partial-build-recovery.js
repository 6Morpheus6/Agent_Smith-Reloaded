#!/usr/bin/env node
/**
 * Proof harness — simulates the budget-tracker partial-build failure pattern
 * (stall → malformed write → recovery → script.js lands) without LM Studio.
 *
 * Usage: node scripts/prove-partial-build-recovery.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const projectContext = require(path.join(ROOT, 'src/main/services/projectContext.js'));
const ChangeLedger = require(path.join(ROOT, 'src/main/services/changeLedger.js'));
const EditEngine = require(path.join(ROOT, 'src/main/services/editEngine.js'));
const { grepProject } = require(path.join(ROOT, 'src/shared/grepTool.js'));
const { globFiles } = require(path.join(ROOT, 'src/shared/globTool.js'));
const { runTurnLoop } = require(path.join(ROOT, 'src/code/loop/turnLoop.js'));
const { EarlyStopDetector } = require(path.join(ROOT, 'src/code/governor/earlyStop.js'));
const { QualityMonitor } = require(path.join(ROOT, 'src/code/governor/qualityMonitor.js'));
const { PlanAnchor } = require(path.join(ROOT, 'src/code/context/planAnchor.js'));
const { checkCompletion } = require(path.join(ROOT, 'src/code/governor/completionGate.js'));

const GOAL = 'Build a complete Personal Budget Tracker web app from scratch with index.html, style.css, script.js, README.md';

const MINIMAL_SCRIPT = `'use strict';
const STORAGE_KEY = 'budget-transactions';
const typeEl = document.getElementById('type');
const amountEl = document.getElementById('amount');
const filterTypeEl = document.getElementById('filter-type');
const totalIncomeEl = document.getElementById('total-income');
const importBtn = document.getElementById('import-btn');
function loadTx() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function saveTx(list) { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
function render() {
  const list = loadTx();
  if (totalIncomeEl) totalIncomeEl.textContent = list.filter(t => t.type === 'income').reduce((s,t)=>s+Number(t.amount||0),0).toFixed(2);
}
if (typeEl) typeEl.addEventListener('change', render);
if (importBtn) importBtn.addEventListener('click', () => alert('import'));
render();
`;

function seedPartial(root) {
    fs.writeFileSync(path.join(root, 'index.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head>
<body>
<form id="tx-form"><select id="type"><option value="income">Income</option><option value="expense">Expense</option></select>
<input id="amount" type="number"><select id="filter-type"></select></form>
<div id="total-income">0</div><button id="import-btn">Import</button>
<script src="script.js"></script></body></html>`);
    fs.writeFileSync(path.join(root, 'style.css'), 'body{background:#111;color:#eee;margin:0;}');
}

function buildExecDeps(sessionId, root) {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-data-'));
    const changeLedger = new ChangeLedger(userDataPath);
    const editEngine = new EditEngine(changeLedger, projectContext);
    return {
        sessionId,
        projectContext,
        editEngine,
        changeLedger,
        grepProject,
        globFiles,
        relPathFromRoot: (p) => path.relative(root, p),
        fireHook: async () => null,
        invokePluginTool: async () => ({ __notFound: true }),
        showPreview: null,
        browserVerify: null,
        runForegroundCommand: async () => ({ stdout: '', stderr: '', error: null }),
        runBackgroundCommand: () => ({ jobId: 1 }),
        listBackgroundOutput: async () => ({ log: [], running: false }),
        stopBackground: async () => ({ ok: true })
    };
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-partial-'));
    projectContext.setRoot(root);
    seedPartial(root);

    const sessionId = 'prove_' + Date.now();
    const session = {
        id: sessionId,
        goal: GOAL,
        projectRoot: root,
        model: 'mock-recovery',
        numCtx: 8192,
        status: 'running',
        turn: 0,
        toolCount: 0,
        phase: 'implement',
        messages: [{ role: 'user', content: GOAL }],
        filesTouched: ['index.html', 'style.css'],
        pendingMissingRefs: ['script.js'],
        completionReflections: 0,
        greenfield: true,
        grindMode: true,
        projectMeta: { language: 'unknown' }
    };

    const events = [];
    let call = 0;
    let turnAfterStallSequence = null;

    // Replays the live failure transcript:
    // 1) stall (retry, no turn burn)
    // 2-5) three more stalls then exhaustion → stall_recovery nudge
    // 6) malformed write_file (content, no path) → salvaged to script.js
    // 7) model tries to stop → gate blocks for README → write README
    const streamCompletion = async () => {
        call++;
        if (call === 1) throw new Error('LM Studio response stalled for 60000ms');
        if (call >= 2 && call <= 5) throw new Error('LM Studio response stalled for 60000ms');
        if (call === 6) {
            return {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'malformed',
                        type: 'function',
                        function: {
                            name: 'write_file',
                            arguments: { content: MINIMAL_SCRIPT }
                        }
                    }]
                },
                finishReason: 'tool_calls'
            };
        }
        if (call === 7) {
            return { message: { role: 'assistant', content: 'Done with script.js!' }, finishReason: 'stop' };
        }
        if (call === 8) {
            return {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'readme',
                        type: 'function',
                        function: {
                            name: 'write_file',
                            arguments: {
                                path: 'README.md',
                                content: '# Budget Tracker\n\nOpen index.html in a browser.\n'
                            }
                        }
                    }]
                },
                finishReason: 'tool_calls'
            };
        }
        return { message: { role: 'assistant', content: 'All files complete.' }, finishReason: 'stop' };
    };

    const execDeps = buildExecDeps(sessionId, root);
    const ctx = {
        session,
        apiBaseUrl: 'http://mock',
        emit: (e) => {
            events.push(e);
            if (e.type === 'run_continue' && e.reason === 'stall_recovery' && turnAfterStallSequence == null) {
                turnAfterStallSequence = session.turn;
            }
        },
        signal: undefined,
        execDeps,
        planAnchor: new PlanAnchor(GOAL),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 20 }),
        streamCompletion,
        userPrompt: GOAL
    };

    console.log('=== Partial-build recovery proof ===');
    console.log('Workspace:', root);
    console.log('Starting files: index.html, style.css (script.js + README.md missing)\n');

    await runTurnLoop(ctx);

    const scriptPath = path.join(root, 'script.js');
    const readmePath = path.join(root, 'readme.md');
    const hasScript = fs.existsSync(scriptPath);
    const hasReadme = fs.existsSync(readmePath) || fs.existsSync(path.join(root, 'README.md'));
    const scriptSize = hasScript ? fs.statSync(scriptPath).size : 0;

    const streamRetries = events.filter(e => e.type === 'stream_retry');
    const stallRecovery = events.filter(e => e.type === 'run_continue' && e.reason === 'stall_recovery');
    const toolStarts = events.filter(e => e.type === 'tool_start' && e.name === 'write_file');
    const gateRetries = events.filter(e => e.type === 'run_continue' && e.reason === 'gate_retry');

    console.log('--- Simulated LLM calls:', call);
    console.log('--- Turn after stall sequence (4 retries + recovery):', turnAfterStallSequence);
    console.log('--- Final session turn counter:', session.turn);
    console.log('--- stream_retry events:', streamRetries.length, streamRetries.map(e => e.attempt).join(','));
    console.log('--- stall_recovery events:', stallRecovery.length);
    console.log('--- write_file tool calls:', toolStarts.map(e => e.args?.path || '(salvaged)').join(', '));
    console.log('--- gate_retry events:', gateRetries.length);
    console.log('--- script.js on disk:', hasScript, `(${scriptSize} bytes)`);
    console.log('--- README.md on disk:', hasReadme);
    console.log('--- filesTouched:', session.filesTouched.join(', '));
    console.log('--- session.status:', session.status);

    const gate = await checkCompletion(root, session.filesTouched, GOAL, { grindMode: false });
    const artifactMsgs = (gate.messages || []).filter(m => /^\[ARTIFACT\]/i.test(m));
    const webMsgs = (gate.messages || []).filter(m => /^\[WEB\]/i.test(m) && /script\.js/i.test(m));
    console.log('--- gate allow (4/4 files):', gate.allow, '| remaining:', (gate.messages || []).length, 'issues');
    if (!gate.allow) {
        console.log('    (expected: may still fail ACCEPT/FUNCTIONAL — proof is delivery path, not full app quality)');
        console.log('    sample:', (gate.messages || []).slice(0, 4).join(' | '));
    }

    // Assertions — the delivery path must work
    assert.ok(streamRetries.length >= 1, 'stall must trigger stream_retry');
    assert.ok(stallRecovery.length >= 1, 'stall exhaustion must inject stall_recovery');
    assert.equal(turnAfterStallSequence, 0, '4 stall retries must not advance turn (would be 5 without fix; got 0)');
    assert.ok(hasScript, 'script.js must land on disk after malformed write recovery');
    assert.ok(scriptSize > 200, 'script.js must have real content');
    assert.ok(hasReadme, 'README.md must land after gate retry');
    assert.ok(session.filesTouched.includes('script.js'), 'script.js must be in filesTouched');
    assert.equal(artifactMsgs.some(m => /script\.js/i.test(m)), false, 'gate must not report script.js missing');
    assert.equal(webMsgs.length, 0, 'gate must not report script.js web ref missing');

    const nudge = session.messages.find(m => m.role === 'system' && /STALL RECOVERY/i.test(m.content));
    assert.ok(nudge, 'stall recovery nudge must be injected');
    assert.match(nudge.content, /script\.js/);

    console.log('\n✓ PROOF PASSED — stall retry, recovery nudge, and malformed-write salvage delivered script.js + README.md');
    console.log('  Workspace kept at:', root);
}

main().catch((e) => {
    console.error('\n✗ PROOF FAILED:', e.message);
    process.exit(1);
});
