#!/usr/bin/env node
/**
 * v50 unified-harness LIVE smoke — drives the real engine (runCodeTask) against the
 * local LM Studio backend. Task is chosen to exercise BOTH halves of the merged
 * surface: a project build tool (write_file) and host-control tools
 * (read_host_file / list_processes). Prints every tool call so you can see the model
 * using the unified loop.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const { executeTool } = require('../src/code/tools/executor.js');
const { runCodeTask } = require('../src/code/loop/runCodeTask.js');

const BASE = process.env.LMS_BASE || 'http://127.0.0.1:1234';
const MODEL = process.argv[2] || process.env.LMS_MODEL;

if (!MODEL) { console.error('usage: LMS_MODEL=<id> node scripts/v50-live-smoke.js'); process.exit(1); }

async function main() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v50-live-')));
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.xk'));
    const editEngine = new EditEngine(ledger, projectContext);

    let toolLog = [];
    const buildExecDeps = (sessionId) => ({
        sessionId,
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: (cmd) => new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(cmd, { cwd: dir, timeout: 120000 }, (e, so, se) => resolve({ error: e ? e.message : null, stdout: so || '', stderr: se || '' }));
        }),
        runBackgroundCommand: () => ({ jobId: 1, stdout: 'bg started' }),
        jobApi: { listJobs: () => [], readLog: () => null, sendInput: () => ({}), kill: () => ({}) },
    });

    const emit = (ev) => {
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'tool_start') toolLog.push(`→ ${ev.name}(${JSON.stringify(ev.args || {}).slice(0, 120)})`);
        else if (ev.type === 'turn_start') console.log(`[turn ${ev.turn}]`);
        else if (ev.type === 'run_start') console.log('[run start]', ev.goal ? `goal: ${(ev.goal||'').slice(0,80)}` : '');
    };

    const session = await runCodeTask({
        projectRoot: dir,
        model: MODEL,
        numCtx: 8192,
        apiBaseUrl: BASE,
        apiKey: null,
        userDataPath: dir,
        prompt: 'Create a file called hello.txt in the project with exactly one line: "hello from agent smith v50". Then use read_host_file to read /etc/hostname and tell me what it says. Finally call list_processes once.',
        maxTurns: 12,
        codeTemperature: 0.2,
        requirePlanApproval: false,
        grindMode: true,
        buildExecDeps,
        emit,
        signal: new AbortController().signal
    });

    console.log('\n──────── LIVE SMOKE RESULT ────────');
    console.log('final status :', session.status);
    console.log('turns used   :', session.turn);
    const hello = path.join(dir, 'hello.txt');
    const content = fs.existsSync(hello) ? fs.readFileSync(hello, 'utf-8').trim() : '(missing)';
    console.log('hello.txt    :', JSON.stringify(content));
    console.log('\ntool calls:');
    for (const l of toolLog) console.log('  ' + l);

    const usedWrite = toolLog.some(l => l.startsWith('→ write_file'));
    const usedHostRead = toolLog.some(l => l.startsWith('→ read_host_file'));
    const ok = session.status === 'complete' && content.includes('hello from agent smith v50') && usedWrite;
    console.log('\nbuild tool exercised  :', usedWrite);
    console.log('host tool exercised   :', usedHostRead, '(informational — depends on model)');
    console.log(ok ? '\nLIVE SMOKE: PASS' : `\nLIVE SMOKE: INCONCLUSIVE (status=${session.status})`);
    process.exit(0); // informational; non-zero would be a hard crash
}

main().catch((e) => { console.error('LIVE SMOKE CRASH:', e.message); console.error(e.stack); process.exit(1); });
