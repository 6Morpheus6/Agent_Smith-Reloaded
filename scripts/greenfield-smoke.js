#!/usr/bin/env node
/**
 * Greenfield exit-path smoke — mocked LLM returns prose-only (0 tools) on turn 1.
 * Must NOT complete a build goal in one turn; completion gate forces reflection.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

function tmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main() {
    const projectRoot = tmp('greenfield-smoke-');
    const session = {
        id: 'gf-smoke',
        goal: 'Build a web based Pac-Man game in HTML CSS and JS',
        projectRoot,
        model: 'test-model',
        numCtx: 8192,
        status: 'running',
        turn: 0,
        toolCount: 0,
        messages: [{ role: 'user', content: 'Build Pac-Man' }],
        filesTouched: [],
        completionReflections: 0,
        phase: 'implement'
    };

    let streamCalls = 0;
    const events = [];

    const ctx = {
        session,
        apiBaseUrl: 'http://127.0.0.1:1234',
        tools: [],
        emit: (e) => events.push(e),
        signal: undefined,
        execDeps: {},
        planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 5 }),
        streamCompletion: async () => {
            streamCalls++;
            return {
                message: { role: 'assistant', content: 'Done! The game is complete.' },
                finishReason: 'stop'
            };
        }
    };

    await runTurnLoop(ctx);

    if (session.status === 'done' && session.filesTouched.length === 0) {
        throw new Error('FAIL: greenfield build completed with 0 files in one pass');
    }
    if (streamCalls < 2) {
        throw new Error(`FAIL: expected reflection re-stream (got ${streamCalls} LLM calls)`);
    }
    const blocked = events.some(e => e.type === 'verify_blocked') ||
        session.completionReflections > 0 ||
        session.status !== 'done';
    if (!blocked && session.filesTouched.length === 0) {
        throw new Error('FAIL: no gate block or reflection on empty greenfield run');
    }

    console.log('greenfield-smoke: OK (calls=%d status=%s reflections=%d)',
        streamCalls, session.status, session.completionReflections || 0);
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
