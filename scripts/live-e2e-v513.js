#!/usr/bin/env node
/**
 * v51.3 LIVE e2e — drive the REAL Code Mode turn loop against LM Studio with
 * qwen3.8-27b-uncensored (the exact model + task from the field report: "build me a
 * simple web based game of snake"). No mocks: real streamCompletion, real tools,
 * real files on disk, real completion gate.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT); // resolve node_modules + service-relative paths like inside the app

const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');
const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');

const MODEL = process.env.E2E_MODEL || 'qwen3.8-27b-uncensored';
const API_BASE = process.env.E2E_API || 'http://127.0.0.1:1234';
const MAX_TURNS = Number(process.env.E2E_MAX_TURNS || 14);

async function main() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v513-e2e-snake-'));
    const userDataPath = path.join(projectRoot, '.agentsmith-data');
    fs.mkdirSync(userDataPath, { recursive: true });
    projectContext.setRoot(projectRoot);

    const session = {
        id: 'live_e2e_' + Date.now(),
        goal: 'build me a simple web based game of snake',
        projectRoot,
        model: MODEL,
        numCtx: 18432,
        codeTemperature: 0.2,
        status: 'running',
        turn: 0,
        toolCount: 0,
        messages: [{ role: 'user', content: '[TASK]\nbuild me a simple web based game of snake' }],
        filesTouched: [],
        completionReflections: 0,
        phase: 'implement',
        greenfield: true,
        emptyWorkspace: true,
        projectMeta: {}
    };

    const changeLedger = new ChangeLedger(userDataPath);
    const relPathFromRoot = (p) => path.relative(projectRoot, p).replace(/\\/g, '/');

    const execDeps = {
        sessionId: session.id,
        projectContext,
        changeLedger,
        relPathFromRoot,
        runForegroundCommand: (command, cwd) => new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('/bin/sh', ['-c', command], { cwd, timeout: 120000 }, (error, stdout, stderr) => {
                resolve({ error: error ? String(error.message || error).slice(0, 300) : null, stdout: stdout || '', stderr: stderr || '' });
            });
        })
    };

    const events = [];
    const t0 = Date.now();
    const log = (e) => {
        if (e.type === 'delta') return; // too noisy
        const brief = JSON.stringify(e).slice(0, 240);
        console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, e.type, brief.replace(/\n/g, ' '));
        events.push(e);
    };

    await runTurnLoop({
        session,
        apiBaseUrl: API_BASE,
        emit: log,
        signal: undefined,
        execDeps,
        planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: MAX_TURNS }),
        streamCompletion: (opts) => streamCompletion(opts)
    });

    console.log('\n================ RESULT ================');
    console.log('status:', session.status);
    console.log('turns used:', session.turn, ' tools executed:', session.toolCount);
    console.log('filesTouched:', JSON.stringify(session.filesTouched));
    const onDisk = fs.existsSync(projectRoot) ? fs.readdirSync(projectRoot).filter(f => !f.startsWith('.agentsmith')) : [];
    console.log('on disk:', JSON.stringify(onDisk));
    if (session.validation) {
        console.log('validation status:', session.validation.status);
        for (const m of (session.validation.messages || []).slice(0, 8)) console.log('  -', String(m).slice(0, 160));
    }
    const emptyTurns = session.messages.filter(m => m.role === 'assistant' && !(m.content && m.content.trim()) && !m.tool_calls).length;
    console.log('empty assistant turns:', emptyTurns);
    const retried = events.filter(e => e.type === 'stream_retry').length;
    console.log('stall/stream retries:', retried);

    // Pass bar for THIS fix: the model actually wrote files (v51.2 field report had 0).
    const ok = session.filesTouched.length > 0;
    console.log(ok ? 'E2E PASS — files were written' : 'E2E FAIL — no files written');
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
