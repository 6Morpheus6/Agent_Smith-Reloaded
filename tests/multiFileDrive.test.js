/**
 * Multi-file drive — the failure the user hit: the model writes index.html (which links
 * script.js + style.css) but never creates those files, and the run dies INCOMPLETE.
 *
 * The harness must (1) tell the model EXACTLY which files to create next, and (2) keep
 * going as long as it makes progress — a 3-file build needs more than 3 turns and must
 * not be cut off by a fixed reflection budget.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { formatGateMessage } = require('../src/code/governor/completionGate.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

function mkSession(opts) {
    return {
        id: 'test', goal: opts.goal, projectRoot: opts.projectRoot,
        model: 'qwen2.5-coder', numCtx: 8192, status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: opts.filesTouched || [], completionReflections: 0, phase: 'explore',
        // v51.5 TEST BEFORE DONE: these sessions model an ALREADY-VERIFIED baseline (this file's
        // execDeps have no command runner; the drive-under-test is missing-file recovery and
        // reflection budgeting). Unverified-session behavior lives in testBeforeDone.test.js.
        testRunsSinceEdit: opts.filesTouched ? true : false
    };
}

function ctxFor(session, streamFn) {
    const events = [];
    return {
        ctx: {
            session, apiBaseUrl: 'http://x', emit: (e) => events.push(e), signal: undefined,
            execDeps: {}, planAnchor: new PlanAnchor(session.goal), qualityMonitor: new QualityMonitor(),
            earlyStop: new EarlyStopDetector({ maxTurns: 40 }), streamCompletion: streamFn,
            userPrompt: session.goal
        },
        events
    };
}

test('gate message names the missing files and forbids rewriting index.html', () => {
    const msg = formatGateMessage({
        missingRefs: ['scripts.js', 'styles.css'],
        messages: [
            '[WEB] index.html references "scripts.js" but that file is missing on disk',
            '[WEB] index.html references "styles.css" but that file is missing on disk',
            '[ACCEPT] required capability missing: score updates'
        ]
    });
    assert.match(msg, /NEXT tool call/i);
    assert.match(msg, /scripts\.js/);
    assert.match(msg, /styles\.css/);
    assert.match(msg, /Do NOT rewrite index\.html/i);
});

test('DRIVE: model that creates one missing file per turn runs to COMPLETE (not cut off at 3)', async () => {
    const d = tmp('drive-');
    const good = path.join(__dirname, '..', 'examples', 'pacman');
    // index.html links style.css + script.js; both initially absent.
    fs.copyFileSync(path.join(good, 'index.html'), path.join(d, 'index.html'));
    const session = mkSession({ goal: 'Build a web based Pac-Man game', projectRoot: d, filesTouched: ['index.html'] });

    // The "model": each turn it creates the next still-missing referenced file, then says done.
    const steps = [
        () => fs.copyFileSync(path.join(good, 'script.js'), path.join(d, 'script.js')),
        () => fs.copyFileSync(path.join(good, 'style.css'), path.join(d, 'style.css'))
    ];
    let i = 0;
    const stream = async () => {
        if (i < steps.length) { steps[i](); i++; }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
    };

    const { ctx, events } = ctxFor(session, stream);
    await runTurnLoop(ctx);

    assert.equal(session.status, 'done', 'must finish once the missing files are created');
    assert.ok(events.filter(e => e.type === 'verify_blocked').length >= 1, 'gate should have driven a corrective turn');
    const fin = events.find(e => e.type === 'final_summary');
    assert.match(fin.summary, /COMPLETE \(verified\)/);
});

test('DRIVE: progress resets the budget — a 4-file build is not cut off by MAX_REFLECTIONS=3', async () => {
    const d = tmp('drive4-');
    fs.writeFileSync(path.join(d, 'index.html'),
        '<!DOCTYPE html><html><head></head><body><div id="app"></div>' +
        '<script src="m1.js"></script><script src="m2.js"></script>' +
        '<script src="m3.js"></script><script src="m4.js"></script></body></html>');
    const session = mkSession({ goal: 'Build a web page with several script modules', projectRoot: d, filesTouched: ['index.html'] });

    const mods = ['m1.js', 'm2.js', 'm3.js', 'm4.js'];
    let i = 0;
    const stream = async () => {
        if (i < mods.length) { fs.writeFileSync(path.join(d, mods[i]), `// module ${mods[i]}\nconst x${i} = ${i};\n`); i++; }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
    };

    const { ctx, events } = ctxFor(session, stream);
    await runTurnLoop(ctx);

    assert.equal(session.status, 'done', '4 files created across >3 turns must still complete');
    assert.ok(session.turn >= 4, 'should have taken at least 4 turns');
    assert.ok(events.filter(e => e.type === 'verify_blocked').length >= 3);
});
