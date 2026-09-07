/**
 * Edit death-spiral regression — reproduces the failed Pac-Man run where a weak model
 * was forced onto append_file for REVISIONS (because write_file was capped at 60 lines),
 * duplicated gameLoop() until every patch hit "Multiple exact matches", and the run was
 * then killed by "5 consecutive tool errors". Each test pins one of the four fixes that
 * break that trap.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeTool, MAX_WRITE_LINES } = require('../src/code/tools/executor.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const projectContext = require('../src/main/services/projectContext.js');
const { syntaxCheckFile } = require('../src/shared/verificationHarness.js');

function mkDeps(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.ledger'));
    const editEngine = new EditEngine(ledger, projectContext);
    return {
        dir,
        deps: {
            sessionId: `s_${prefix}`,
            projectContext,
            editEngine,
            changeLedger: ledger,
            grepProject: async () => ({ hits: [] }),
            globFiles: async () => ({ files: [] }),
            relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
            runForegroundCommand: async () => ({ stdout: 'ok' }),
            runBackgroundCommand: async () => ({ jobId: 1 })
        }
    };
}

// A complete, normal-sized game file — the kind the 60-line cap made impossible to write,
// forcing the append-fragment path that corrupted the file.
const WHOLE_SCRIPT = Array.from({ length: 190 }, (_, i) => `// line ${i}`).join('\n') +
    '\nfunction gameLoop() { requestAnimationFrame(gameLoop); }\ngameLoop();\n';

test('RC1: a complete ~190-line file is accepted by write_file (no forced fragmentation)', async () => {
    const { dir, deps } = mkDeps('spiral-whole-');
    assert.ok(WHOLE_SCRIPT.split('\n').length > 60, 'fixture must exceed the OLD 60-line cap');
    assert.ok(WHOLE_SCRIPT.split('\n').length < MAX_WRITE_LINES, 'fixture must fit the NEW cap');
    const r = await executeTool('write_file', { path: 'script.js', content: WHOLE_SCRIPT }, deps);
    assert.equal(r.success, true, 'whole file write must succeed: ' + JSON.stringify(r.error));
    const syn = await syntaxCheckFile(dir, 'script.js');
    assert.equal(syn.ok, true, 'the whole-file write parses cleanly');
});

test('RC3: duplicated gameLoop is recoverable — patch replace_all collapses it', async () => {
    const { dir, deps } = mkDeps('spiral-dup-');
    // Reproduce the corruption append_file produced: two gameLoop definitions.
    const dupd =
        'function gameLoop() { /* v1 */ requestAnimationFrame(gameLoop); }\n' +
        'function gameLoop() { /* v1 */ requestAnimationFrame(gameLoop); }\n';
    await executeTool('write_file', { path: 'script.js', content: dupd }, deps);

    // Without replace_all the model gets a DEAD-END today — but now the error is actionable.
    const stuck = await executeTool('patch', {
        path: 'script.js',
        find: 'function gameLoop() { /* v1 */ requestAnimationFrame(gameLoop); }',
        replace: 'function gameLoop() { /* fixed */ requestAnimationFrame(gameLoop); }'
    }, deps);
    assert.ok(stuck.error, 'duplicate find still refuses a single ambiguous replace');
    assert.match(stuck.error, /replace_all|write_file/i, 'error must offer a recovery path');

    // With replace_all the model escapes the trap.
    const fixed = await executeTool('patch', {
        path: 'script.js',
        find: 'function gameLoop() { /* v1 */ requestAnimationFrame(gameLoop); }',
        replace: 'function gameLoop() { requestAnimationFrame(gameLoop); }',
        replace_all: true
    }, deps);
    assert.equal(fixed.error, undefined, 'replace_all must succeed: ' + JSON.stringify(fixed.error));
    const body = fs.readFileSync(path.join(dir, 'script.js'), 'utf8');
    assert.equal(body.split('function gameLoop()').length - 1, 2,
        'both occurrences replaced (the two collapsed copies are now identical-and-correct)');
    assert.ok(!body.includes('/* v1 */'), 'the stale version is gone');
});

test('RC2: append_file refuses to write past </html> (the "<div> after </html>" bug)', async () => {
    const { deps } = mkDeps('spiral-html-');
    await executeTool('write_file', {
        path: 'index.html',
        content: '<!DOCTYPE html><html><head></head><body><canvas></canvas></body></html>\n'
    }, deps);
    const r = await executeTool('append_file', { path: 'index.html', content: '<div id="score">0</div>' }, deps);
    assert.ok(r.error, 'appending after a closed document must be refused');
    assert.match(r.error, /<\/html>|before <\/body>|write_file/i);
});

test('RC2b: append_file refuses to re-declare a symbol already in a .js file', async () => {
    const { deps } = mkDeps('spiral-jsdup-');
    await executeTool('write_file', {
        path: 'script.js',
        content: 'function gameLoop() { requestAnimationFrame(gameLoop); }\nconst maze = [];\n'
    }, deps);

    // The exact failed-run move: add the "next feature" by appending a chunk that
    // re-defines gameLoop. This MUST be refused (it would create a second gameLoop).
    const dup = await executeTool('append_file', {
        path: 'script.js',
        content: 'function gameLoop() { drawMaze(); requestAnimationFrame(gameLoop); }\n'
    }, deps);
    assert.ok(dup.error, 'appending a duplicate definition must be refused');
    assert.match(dup.error, /duplicate|gameLoop|patch|write_file/i);

    // A genuinely NEW top-level function is still fine — append still extends files.
    const ok = await executeTool('append_file', {
        path: 'script.js',
        content: 'function drawGhosts() { /* new */ }\n'
    }, deps);
    assert.equal(ok.error, undefined, 'a new declaration may still be appended');
    assert.equal(ok.appended, true);

    // Continuing a cut-off file (indented body tail, no new column-0 decl) is NOT flagged.
    const cont = await executeTool('append_file', {
        path: 'script.js',
        content: '    const extra = 1;\n    return extra;\n'
    }, deps);
    assert.equal(cont.error, undefined, 'continuation lines must not be mistaken for re-declarations');
});

test('RC2c: append_file refuses to re-declare an ESM-exported symbol (export const/function/class)', async () => {
    // v53.2 — the guard's regex only matched BARE column-0 declarations, so appending
    // `export const add = …` over an existing `add` slipped through: the same
    // duplicate-definition corruption as RC2b, in the module style web builds use.
    const { deps } = mkDeps('spiral-esmdup-');
    await executeTool('write_file', {
        path: 'module.js',
        content: 'export const add = (a, b) => a + b;\nexport function render() {}\nexport default class App {}\n'
    }, deps);

    for (const [label, chunk] of [
        ['export const', 'export const add = () => 1;\n'],
        ['export function', 'export function render() { return 2; }\n'],
        ['export default class', 'export default class App {}\n']
    ]) {
        const dup = await executeTool('append_file', { path: 'module.js', content: chunk }, deps);
        assert.ok(dup.error, `${label} re-declaration must be refused`);
        assert.match(dup.error, /DUPLICATE/i);
    }

    // A genuinely NEW exported symbol is still appendable.
    const ok = await executeTool('append_file', { path: 'module.js', content: '\nexport const sub = (a, b) => a - b;\n' }, deps);
    assert.equal(ok.error, undefined, 'a new export may still be appended');
    assert.equal(ok.appended, true);

    // Indented `const` inside an exported function body is NOT a top-level declaration.
    const cont = await executeTool('append_file', { path: 'module.js', content: '\nexport function f() {\n    const local = 1;\n    return local;\n}\n' }, deps);
    assert.equal(cont.error, undefined, 'indented body declarations must not be flagged');
});

test('RC4: duplicate-skips do not count toward the consecutive-error kill switch', () => {
    // Isolate the error path from the separate duplicate-call limit.
    const det = new EarlyStopDetector({ maxConsecutiveErrors: 5, maxDuplicateTools: 10_000 });
    det.onTurn();
    // The run that died ended on "5 consecutive tool errors" while the model was repeating
    // calls (dedup skips) trying to recover. A skip must not accrue toward THAT counter.
    for (let i = 0; i < 50; i++) {
        const r = det.onToolResult(false, /* wasDuplicate */ true);
        assert.equal(r.stop, false, 'a duplicate skip is never a consecutive tool error');
    }
    // And the interleaving from the transcript (real error, skip, real error, …) must not
    // reach 5 from skips alone: 4 real errors + skips stays under the limit.
    const det2 = new EarlyStopDetector({ maxConsecutiveErrors: 5, maxDuplicateTools: 10_000 });
    det2.onTurn();
    let stopped = false;
    for (const dup of [false, true, false, true, false, true, false]) { // 4 real errors, 3 skips
        stopped = stopped || det2.onToolResult(false, dup).stop;
    }
    assert.equal(stopped, false, '4 real errors interleaved with skips must not hit the 5-error stop');

    // Genuine errors still trip the safety net — the fix narrows it, it does not remove it.
    const det3 = new EarlyStopDetector({ maxConsecutiveErrors: 3 });
    det3.onTurn();
    assert.equal(det3.onToolResult(false, false).stop, false);
    assert.equal(det3.onToolResult(false, false).stop, false);
    assert.equal(det3.onToolResult(false, false).stop, true);
});
