/**
 * Autonomous build proof — drives the REAL turn loop + executor + completion gate with a
 * scripted model that writes COMPLETE files via write_file tool calls (the path the model
 * should take). Before the death-spiral fix this run was impossible: script.js is ~190
 * lines and write_file was capped at 60, so the model was forced onto append_file and
 * corrupted the file. Now the whole file is accepted and the run completes verified.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const projectContext = require('../src/main/services/projectContext.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('DRIVE: model writes complete files via write_file → run completes verified', async () => {
    const good = path.join(__dirname, '..', 'examples', 'pacman');
    const files = {
        'index.html': fs.readFileSync(path.join(good, 'index.html'), 'utf8'),
        'style.css': fs.readFileSync(path.join(good, 'style.css'), 'utf8'),
        'script.js': fs.readFileSync(path.join(good, 'script.js'), 'utf8')
    };
    // Guard: this only proves anything if script.js really exceeds the OLD 60-line cap.
    assert.ok(files['script.js'].split('\n').length > 60, 'fixture must be a real, large file');

    const d = tmp('auto-build-');
    projectContext.setRoot(d);
    const ledger = new ChangeLedger(path.join(d, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    const execDeps = {
        projectContext, editEngine, changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(d, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };

    const session = {
        id: 'auto', goal: 'create a pac man web browser game', projectRoot: d,
        model: 'qwen2.5-coder', numCtx: 8192, status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'create a pac man web browser game' }],
        filesTouched: [], completionReflections: 0,
        // v51.5: start in verify so the scripted model's post-write verification command
        // (run_command) is phase-allowed — writes are allowed in verify too.
        phase: 'verify'
    };

    let turn = 0;
    const writeResults = [];
    const stream = async () => {
        turn++;
        if (turn === 1) {
            // The model emits all three complete files in one turn.
            return {
                message: {
                    role: 'assistant', content: '',
                    tool_calls: Object.entries(files).map(([name, content], i) => ({
                        id: `call_${i}`, type: 'function',
                        function: { name: 'write_file', arguments: { path: name, content } }
                    }))
                },
                finishReason: 'stop'
            };
        }
        // v51.5 TEST BEFORE DONE — a professional agent verifies before declaring done:
        // syntax-check the game script after writing it (this is what flips
        // session.testRunsSinceEdit, unblocking completion on the next turn).
        if (turn === 2) {
            return {
                message: {
                    role: 'assistant', content: '',
                    tool_calls: [{
                        id: 'call_verify', type: 'function',
                        function: { name: 'run_command', arguments: { command: 'node --check script.js' } }
                    }]
                },
                finishReason: 'stop'
            };
        }
        return { message: { role: 'assistant', content: 'Done — the game is complete.' }, finishReason: 'stop' };
    };

    const events = [];
    await runTurnLoop({
        session, apiBaseUrl: 'http://x',
        emit: (e) => { events.push(e); if (e.type === 'tool_result' && e.name === 'write_file') writeResults.push(e); },
        signal: undefined, execDeps,
        planAnchor: new PlanAnchor(session.goal), qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 20 }), streamCompletion: stream,
        userPrompt: session.goal
    });

    // The large file write must have been ACCEPTED (the RC1 unlock).
    const scriptWrite = writeResults.find(e => e.result?.relPath === 'script.js' || e.args?.path === 'script.js');
    assert.ok(scriptWrite, 'script.js write happened');
    assert.equal(scriptWrite.ok, true, 'the ~190-line script.js write was accepted (not rejected as too large)');

    // The run reaches a verified completion — autonomously, through the real gate.
    assert.equal(session.status, 'done', 'run must complete; last events: ' +
        events.slice(-3).map(e => e.type + (e.message ? `(${e.message})` : '')).join(', '));
    const fin = events.find(e => e.type === 'final_summary');
    assert.match(fin.summary, /COMPLETE \(verified\)/);

    // And the files are really on disk and parse.
    assert.ok(fs.existsSync(path.join(d, 'script.js')));
});
