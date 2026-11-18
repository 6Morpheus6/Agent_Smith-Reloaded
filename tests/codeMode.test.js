/**
 * Code Mode unit tests — extractor, budget, earlyStop, executor+ledger.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { extractFromMessage, extractToolCallsFromText } = require('../src/code/tools/extractor.js');
const { fitBudget, estimateMessages } = require('../src/code/context/budget.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { TurnDedup } = require('../src/code/tools/dedup.js');
const { executeTool, MAX_WRITE_LINES, checkWriteChunkSize } = require('../src/code/tools/executor.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const projectContext = require('../src/main/services/projectContext.js');
const { apiBase } = require('../src/code/loop/streamCompletion.js');
const { normalizeLlmBaseUrl } = require('../src/shared/netGuard.js');

test('apiBase maps localhost to 127.0.0.1 for LM Studio on Windows', () => {
    assert.equal(apiBase('http://localhost:1234'), 'http://127.0.0.1:1234');
    assert.equal(normalizeLlmBaseUrl('http://localhost:1234/v1'), 'http://127.0.0.1:1234');
});

test('extractor recovers tool_call tags', () => {
    const msg = { content: '<tool_call>{"name":"read_file","parameters":{"path":"a.js"}}</tool_call>' };
    const r = extractFromMessage(msg, [{ function: { name: 'read_file' } }]);
    assert.equal(r.addedCalls, 1);
    assert.equal(msg.tool_calls[0].function.name, 'read_file');
});

test('extractToolCallsFromText ignores unknown tools', () => {
    const calls = extractToolCallsFromText('{"name":"bogus","parameters":{}}', new Set(['read_file']));
    assert.equal(calls, null);
});

test('fitBudget drops old messages under tight budget', () => {
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'the goal' },              // small task — must survive
        { role: 'assistant', content: 'b'.repeat(4000) },   // old + large — evicted
        { role: 'user', content: 'c'.repeat(4000) },        // old + large — evicted
        { role: 'user', content: 'latest' }
    ];
    const out = fitBudget(msgs, 500);
    // the oldest oversized messages are evicted, the goal + latest are kept,
    // and a compaction breadcrumb replaces the dropped context (not silent loss).
    assert.ok(!out.some(m => m.content === 'b'.repeat(4000)), 'old large message dropped');
    assert.ok(out.some(m => m.content === 'the goal'), 'original goal kept');
    assert.ok(out.some(m => m.content === 'latest'), 'latest kept');
    assert.ok(out.some(m => typeof m.content === 'string' && m.content.includes('CONTEXT COMPACTED')), 'compaction breadcrumb present');
});

test('earlyStop halts after max consecutive errors', () => {
    const det = new EarlyStopDetector({ maxConsecutiveErrors: 3 });
    det.onTurn();
    assert.equal(det.onToolResult(false, false).stop, false);
    assert.equal(det.onToolResult(false, false).stop, false);
    const r = det.onToolResult(false, false);
    assert.equal(r.stop, true);
});

test('dedup short-circuits identical calls', () => {
    const d = new TurnDedup();
    assert.equal(d.isDuplicate('grep', { pattern: 'foo' }), false);
    assert.equal(d.isDuplicate('grep', { pattern: 'foo' }), true);
});

test('dedup remembers failed calls across turns until a write makes progress', () => {
    const d = new TurnDedup();
    const args = { path: 'script.js', find: 'x', replace: 'y' };
    assert.equal(d.isDuplicate('patch', args), false);
    d.recordResult('patch', args, false);
    d.reset();
    assert.equal(d.isDuplicate('patch', args), true);
    d.clearFailures();
    d.reset();
    assert.equal(d.isDuplicate('patch', args), false);
});

test('dedup unlocks a failed write after the model reads that path again', () => {
    // Regression: the block used to be permanent for the whole run, so the recovery step the
    // harness itself demands (read_file, then retry) could never actually retry.
    const d = new TurnDedup();
    const args = { path: 'script.js', content: 'const a = 1;\n' };
    assert.equal(d.isDuplicate('write_file', args), false);
    d.recordResult('write_file', args, false, { error: 'The "data" argument must be of type string' });
    d.reset();
    assert.equal(d.isDuplicate('write_file', args), true, 'byte-identical retry stays blocked');
    assert.match(d.failureReason('write_file', args) || '', /data/, 'the original error is available to show');

    d.clearFailuresForPath('script.js');
    d.reset();
    assert.equal(d.isDuplicate('write_file', args), false, 'reading the path unlocks the retry');

    // A failure on another path is untouched by that unlock.
    const other = { path: 'style.css', content: 'body{}' };
    assert.equal(d.isDuplicate('write_file', other), false);
    d.recordResult('write_file', other, false, { error: 'boom' });
    d.clearFailuresForPath('script.js');
    d.reset();
    assert.equal(d.isDuplicate('write_file', other), true);
});

test('earlyStop only kills a RUN of duplicate tool calls', () => {
    // Regression: the duplicate counter was cumulative for the whole run, so a long session
    // that repeated eight calls across hours died as if it were stuck in a loop.
    const { EarlyStopDetector: Det } = require('../src/code/governor/earlyStop.js');
    const det = new Det({ maxDuplicateTools: 3 });
    const dup = () => det.onToolResult(false, true).stop;
    assert.equal(dup(), false);
    assert.equal(det.onToolResult(true, false).stop, false, 'a distinct call is progress');
    assert.equal(dup(), false);
    assert.equal(dup(), false);
    assert.equal(dup(), true, 'three duplicates in a row stop the run');
});

test('checkWriteChunkSize rejects oversized write_file payloads', () => {
    const big = 'line\n'.repeat(MAX_WRITE_LINES + 1);
    const err = checkWriteChunkSize(big);
    assert.ok(err?.error);
    assert.match(err.error, new RegExp(`${MAX_WRITE_LINES}`));
    assert.match(err.error, /too large/i);
    // a normal whole source file (well under the cap) must be accepted, so the model
    // can write a complete file instead of being forced onto the append-fragment path.
    assert.equal(checkWriteChunkSize('line\n'.repeat(200)), null);
    assert.equal(checkWriteChunkSize('ok\n'), null);
    // Regression: a complete ~449-line module (real multi-file apps have these) must be
    // accepted — it was previously bounced at the old 400-line cap, derailing the build.
    assert.equal(checkWriteChunkSize('const x = 1;\n'.repeat(449)), null);
    assert.equal(checkWriteChunkSize('const x = 1;\n'.repeat(800)), null);
    assert.ok(MAX_WRITE_LINES >= 1000, 'cap must comfortably hold a normal source module');
});

test('executor write_file + ledger snapshot', async () => {
    const dir = path.join(os.tmpdir(), `code-exec-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    const ledgerDir = path.join(dir, '.ledger');
    const ledger = new ChangeLedger(ledgerDir);
    const editEngine = new EditEngine(ledger, projectContext);
    const sessionId = 'test_session';
    const deps = {
        sessionId,
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
    const r = await executeTool('write_file', { path: 'hello.txt', content: 'hi\n' }, deps);
    assert.equal(r.success, true);
    const diff = await ledger.diff(sessionId);
    assert.ok(diff.fileCount >= 1);

    // A write whose file text arrived under the wrong key must be a clear tool error that
    // names the field — not Node's raw `The "data" argument must be of type string`, and
    // certainly not a file on disk.
    const bad = await executeTool('write_file', { path: 'page.html', data: '<h1>x</h1>' }, deps);
    assert.match(String(bad.error || ''), /requires "content"/i);
    assert.match(String(bad.error || ''), /NOTHING was written/i);
    assert.ok(!fs.existsSync(path.join(dir, 'page.html')), 'no file is created from a malformed call');
});

test('executor append_file grows an existing file', async () => {
    const dir = path.join(os.tmpdir(), `code-append-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    const deps = {
        sessionId: 'append_session',
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
    const w = await executeTool('write_file', { path: 'game.js', content: 'const score = 0;\n' }, deps);
    assert.equal(w.success, true);
    const a = await executeTool('append_file', { path: 'game.js', content: 'function tick() { score++; }\n' }, deps);
    assert.equal(a.success, true);
    assert.equal(a.appended, true);
    const body = fs.readFileSync(path.join(dir, 'game.js'), 'utf8');
    assert.match(body, /function tick/);
    assert.match(body, /const score/);
});

test('executor rejects a no-op patch instead of reporting fake progress', async () => {
    const dir = path.join(os.tmpdir(), `code-noop-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'style.css'), '.wall { color: blue; }\n');
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    const result = await executeTool('patch', {
        path: 'style.css',
        find: '.wall { color: blue; }',
        replace: '.wall { color: blue; }'
    }, {
        sessionId: 'noop',
        projectContext,
        editEngine,
        changeLedger: ledger,
        relPathFromRoot: p => path.relative(dir, p).replace(/\\/g, '/')
    });

    assert.match(result.error, /no-op/i);
});

test('executor rejects append_file when file missing', async () => {
    const dir = path.join(os.tmpdir(), `code-append-miss-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    const deps = {
        sessionId: 'append_miss',
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
    const r = await executeTool('append_file', { path: 'nope.js', content: 'x\n' }, deps);
    assert.ok(r.error);
    assert.match(r.error, /not found/i);
});

test('executor warns on broken template literals in write_file', async () => {
    const dir = path.join(os.tmpdir(), `code-warn-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    const deps = {
        sessionId: 'warn_session',
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
    const bad = 'gameBoardElement.style.gridTemplateColumns = repeat(${COLS}, 30px);\n';
    const r = await executeTool('write_file', { path: 'broken.js', content: bad }, deps);
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.warnings));
    assert.ok(r.warnings.some(w => /template literal/i.test(w)));
});

test('completionGate detects truncation and syntax errors', async () => {
    const { detectContentIssues, checkCompletion, goalImpliesBuildWork } = require('../src/code/governor/completionGate.js');
    const issues = detectContentIssues('game.js', 'function foo() {\n  repeat(${n}, 30px);\n');
    assert.ok(issues.some(i => /template literal/i.test(i)));
    assert.ok(issues.some(i => /unbalanced/i.test(i)));

    const dir = path.join(os.tmpdir(), `code-gate-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const badJs = 'function incomplete() {\n  const x = 1;\n';
    fs.writeFileSync(path.join(dir, 'script.js'), badJs, 'utf-8');
    const gate = await checkCompletion(dir, ['script.js'], 'fix script');
    assert.equal(gate.allow, false);
    assert.ok(gate.messages.length > 0);

    assert.equal(goalImpliesBuildWork('Build a web based Pac-Man game'), true);
    const empty = await checkCompletion(dir, [], 'Build a web based Pac-Man game');
    assert.equal(empty.allow, false, 'build goal with no files must block completion');
    assert.ok(empty.messages.some(m => /no project files/i.test(m)));
});

test('REGRESSION: zero files written never grades the workspace\'s own app as the deliverable', async () => {
    const { checkCompletion } = require('../src/code/governor/completionGate.js');
    const { findIndexHtmlDeep } = require('../src/code/context/fileScan.js');
    // The Super Mario run that wrote nothing: its workspace was the harness's own repo, and
    // the gate deep-scanned it, reporting the app's settings toggles as the "game" and
    // passing all six game-acceptance checks against the app's own HTML.
    const dir = path.join(os.tmpdir(), `code-gate-ownapp-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'index.html'), [
        '<!DOCTYPE html><html><body>',
        '<button id="auto-tune-toggle">tune</button>',
        '<canvas id="game"></canvas><div id="player"></div><div id="score">0</div>',
        '<script src="app.js"></script>',
        '</body></html>'
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(dir, 'app', 'app.js'), [
        'const player = document.getElementById("player");',
        'document.addEventListener("keydown", () => { player.dataset.moving = "1"; });',
        'function loop() { requestAnimationFrame(loop); }',
        'requestAnimationFrame(loop);',
        'let score = 0;',
        'score += 1; document.getElementById("score").textContent = score;',
        'if (score > 10) { /* win */ }',
        ''
    ].join('\n'), 'utf-8');
    // pre-condition: the deep fallback WOULD have found this app (so the guard is what saves us)
    assert.ok(findIndexHtmlDeep(dir, 4), 'fixture must be reachable by the deep scan');

    const gate = await checkCompletion(
        dir, [],
        'Make me a web based game of classic Super Mario that only has a single level and when player reaches the end goal restart the level.',
        { grindMode: true }
    );
    assert.equal(gate.allow, false);
    assert.equal(gate.acceptance.applicable, false, 'nothing was written, so no acceptance check may pass');
    assert.equal(gate.smoke.skipped, true);
    assert.ok(!gate.messages.some(m => /auto-tune-toggle|\[SMOKE\]|\[DOM\]/.test(m)),
        `gate must not grade an app the run did not write: ${gate.messages.join(' | ')}`);
});

test('pacman example script passes node --check', async () => {
    const scriptPath = path.join(__dirname, '..', 'examples', 'pacman', 'script.js');
    const { syntaxCheckFile } = require('../src/shared/verificationHarness.js');
    const root = path.join(__dirname, '..', 'examples', 'pacman');
    const r = await syntaxCheckFile(root, 'script.js');
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(scriptPath));
});
