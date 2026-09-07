#!/usr/bin/env node
/**
 * Live partial-build resume — seeds HTML+CSS, asks Code Mode to finish script.js + README.
 * Proves recovery path against a real model (requires LM Studio).
 *
 * Usage:
 *   LMS_URL=http://127.0.0.1:1234 MAXTURNS=15 node scripts/prove-partial-build-live.js [model]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const projectContext = require(path.join(ROOT, 'src/main/services/projectContext.js'));
const ChangeLedger = require(path.join(ROOT, 'src/main/services/changeLedger.js'));
const EditEngine = require(path.join(ROOT, 'src/main/services/editEngine.js'));
const { grepProject } = require(path.join(ROOT, 'src/shared/grepTool.js'));
const { globFiles } = require(path.join(ROOT, 'src/shared/globTool.js'));
const { runCodeTask } = require(path.join(ROOT, 'src/code/loop/runCodeTask.js'));
const { checkCompletion } = require(path.join(ROOT, 'src/code/governor/completionGate.js'));

const LMS = process.env.LMS_URL || 'http://127.0.0.1:1234';
const MAXTURNS = Number(process.env.MAXTURNS) || 15;
const MODEL = process.argv[2] || 'qwen/qwen3-coder-30b';

const RESUME_PROMPT = `index.html and style.css already exist and are correct — do NOT change them.
Create script.js (budget tracker: localStorage, CRUD for income/expense transactions, filter by type, totals for income/expense/balance, element ids: type, amount, filter-type, total-income, import-btn) and README.md.
Use write_file path="script.js" first. Do not call list_project or grep.`;

function seed(root) {
    fs.writeFileSync(path.join(root, 'index.html'), `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="style.css"></head>
<body>
<form id="tx-form"><select id="type"><option value="income">Income</option><option value="expense">Expense</option></select>
<input id="amount" type="number"><select id="filter-type"></select></form>
<div id="total-income">0</div><div id="total-expense">0</div><div id="balance">0</div>
<button id="import-btn">Import</button><div id="transaction-list"></div>
<script src="script.js"></script></body></html>`);
    fs.writeFileSync(path.join(root, 'style.css'), 'body{background:#111;color:#eee;}');
}

async function main() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-live-'));
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-live-data-'));
    seed(workspace);
    projectContext.setRoot(workspace);

    function buildExecDeps(sessionId) {
        const changeLedger = new ChangeLedger(userDataPath);
        const editEngine = new EditEngine(changeLedger, projectContext);
        return {
            sessionId, projectContext, editEngine, changeLedger, grepProject, globFiles,
            relPathFromRoot: (p) => {
                const r = projectContext.getRootOrNull();
                return r ? path.relative(r, p) : p;
            },
            fireHook: async () => null,
            invokePluginTool: async () => ({ __notFound: true }),
            showPreview: null,
            browserVerify: null,
            runForegroundCommand: (cmd, cwd) => new Promise((res) => {
                require('child_process').exec(cmd, { cwd, timeout: 60000 }, (err, stdout, stderr) =>
                    res({ error: err ? err.message : null, stdout: stdout || '', stderr: stderr || '' }));
            }),
            runBackgroundCommand: () => ({ jobId: 1 }),
            listBackgroundOutput: async () => ({ log: [], running: false }),
            stopBackground: async () => ({ ok: true })
        };
    }

    console.log('=== Live partial-build resume proof ===');
    console.log('Model:', MODEL, '| LMS:', LMS, '| MAXTURNS:', MAXTURNS);
    console.log('Workspace:', workspace);
    console.log('Pre-seeded: index.html, style.css\n');

    const events = [];
    const session = await runCodeTask({
        prompt: RESUME_PROMPT,
        projectRoot: workspace,
        userDataPath,
        apiBaseUrl: LMS,
        model: MODEL,
        numCtx: 32768,
        maxTurns: MAXTURNS,
        projectContext,
        buildExecDeps,
        grindMode: false,
        emit: (e) => {
            events.push(e);
            if (e.type === 'tool_start') {
                process.stdout.write(`  [turn ${e.turn || '?'}] ${e.name} ${e.args?.path || ''}\n`);
            } else if (e.type === 'tool_result' && !e.ok) {
                const err = e.result?.error || e.result?.message || JSON.stringify(e.result).slice(0, 120);
                process.stdout.write(`  [✗ ${e.name}] ${err}\n`);
            } else if (e.type === 'stream_retry') {
                process.stdout.write(`  [⟳ stall retry ${e.attempt}]\n`);
            } else if (e.type === 'run_continue' && e.reason === 'stall_recovery') {
                process.stdout.write(`  [↻ stall recovery nudge]\n`);
            }
        }
    });

    const hasScript = fs.existsSync(path.join(workspace, 'script.js'));
    const hasReadme = fs.existsSync(path.join(workspace, 'README.md'));
    const scriptBytes = hasScript ? fs.statSync(path.join(workspace, 'script.js')).size : 0;
    const streamRetries = events.filter(e => e.type === 'stream_retry').length;
    const stallRecovery = events.filter(e => e.type === 'run_continue' && e.reason === 'stall_recovery').length;
    const writes = events.filter(e => e.type === 'tool_start' && e.name === 'write_file');

    const gate = await checkCompletion(workspace, session.filesTouched || [], RESUME_PROMPT, { grindMode: false });
    const missingScript = (gate.messages || []).some(m => /script\.js.*missing/i.test(m));

    console.log('--- Turns used:', session.turn);
    console.log('--- stream_retry:', streamRetries, '| stall_recovery:', stallRecovery);
    console.log('--- write_file calls:', writes.map(w => w.args?.path).filter(Boolean).join(', ') || '(none)');
    console.log('--- script.js:', hasScript, `(${scriptBytes} bytes)`);
    console.log('--- README.md:', hasReadme);
    console.log('--- status:', session.status);
    console.log('--- gate script missing:', missingScript);

    if (hasScript && scriptBytes > 100 && !missingScript) {
        console.log('\n✓ LIVE PROOF PASSED — model delivered script.js on partial build');
        process.exit(0);
    }
    console.log('\n✗ LIVE PROOF FAILED — script.js not delivered');
    if (gate.messages?.length) console.log('Gate:', gate.messages.slice(0, 5).join('\n'));
    process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
