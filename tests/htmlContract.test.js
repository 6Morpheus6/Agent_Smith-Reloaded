const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const {
    captureHtmlIdContract,
    buildDomContractNudge,
    buildDomRepairNudge,
    checkDomRepairWrite,
    parseDomGateItems,
    clearDomRepairsIfScriptPatched,
    domContractClean,
    collectDomRepairsFromDisk,
    detectDomMismatchState,
    bootstrapDomRepair
} = require('../src/code/context/htmlContract.js');

function mkproj(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-contract-'));
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
    return root;
}

test('earlyStop counts patch edits as progress', () => {
    const det = new EarlyStopDetector({ maxNoWriteTurns: 3 });
    det.onProgress(3); det.onProgress(3);
    det.onProgress(3, { hadEdit: true });
    assert.equal(det.onProgress(3).stop, false, 'an edit resets the no-write counter');
});

test('captureHtmlIdContract stores ids and builds a canonical-id nudge', () => {
    const root = mkproj({ 'index.html': '<input id="total-income"><select id="filter-type"></select>' });
    const session = { projectRoot: root };
    const ids = captureHtmlIdContract(session, 'index.html');
    assert.ok(ids.includes('total-income') && ids.includes('filter-type'));
    const nudge = buildDomContractNudge(session);
    assert.match(nudge, /total-income/);
    assert.match(nudge, /Do NOT invent ids/i);
    fs.rmSync(root, { recursive: true, force: true });
});

test('DOM repair blocks rewriting the (correct) index.html, but NOT script.js', () => {
    const session = { pendingDomRepairs: [{ wrong: 'income-total', right: 'total-income' }] };
    const htmlBlocked = checkDomRepairWrite(session, 'write_file', { path: 'index.html', content: '<html></html>' });
    assert.ok(htmlBlocked);
    assert.match(htmlBlocked.error, /script\.js/);
    // script.js writes/patches stay allowed — the model fixes it itself (ledger-tracked).
    assert.equal(checkDomRepairWrite(session, 'write_file', { path: 'script.js', content: 'x' }), null);
});

test('detectDomMismatchState finds a broken contract when all files exist (read-only)', () => {
    const root = mkproj({
        'index.html': '<html><body><p id="total-income"></p><script src="script.js"></script></body></html>',
        'script.js': "getElementById('income-total');"
    });
    const state = detectDomMismatchState(root, 'Build index.html style.css script.js budget tracker', []);
    assert.ok(state);
    assert.equal(state.scriptRel, 'script.js');
    assert.ok(state.repairs.some(r => r.wrong === 'income-total' && r.right === 'total-income'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('SAFETY: detection/bootstrap NEVER rewrites the model script on disk', () => {
    const root = mkproj({
        'index.html': '<p id="total-income"></p><script src="script.js"></script>',
        // two legitimate `const cell` in different scopes + an id mismatch + an orphan
        'script.js': [
            "function a(){ const cell = document.getElementById('income-total'); return cell; }",
            "function b(){ const cell = document.getElementById('add-transaction-btn'); return cell; }"
        ].join('\n')
    });
    const before = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
    const session = { projectRoot: root, goal: 'Build index.html script.js app', messages: [], filesTouched: [] };
    bootstrapDomRepair(session, { pushMessages: true });
    collectDomRepairsFromDisk(root);
    const after = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
    assert.equal(after, before, 'the harness must not modify the model source');
    assert.equal((after.match(/const cell\b/g) || []).length, 2, 'both valid declarations preserved');
    fs.rmSync(root, { recursive: true, force: true });
});

test('parseDomGateItems extracts the rename map from [DOM] messages', () => {
    const items = parseDomGateItems([
        '[DOM] script references #income-total but no element with id="income-total" exists in the HTML — did you mean #total-income?'
    ]);
    assert.equal(items[0].wrong, 'income-total');
    assert.equal(items[0].right, 'total-income');
});

test('buildDomRepairNudge lists renames and sets pendingDomRepairs', () => {
    const session = {};
    const nudge = buildDomRepairNudge(session, ['[DOM] script references #balance but no element — did you mean #current-balance?']);
    assert.match(nudge, /current-balance/);
    assert.match(nudge, /patch script\.js/i);
    assert.ok(session.pendingDomRepairs?.length);
});

test('clearDomRepairsIfScriptPatched keeps repairs until ids match, then clears', () => {
    const root = mkproj({ 'index.html': '<p id="total-income"></p>', 'script.js': "getElementById('totalIncome');" });
    const session = { projectRoot: root, pendingDomRepairs: [{ wrong: 'totalIncome', right: 'total-income' }] };
    clearDomRepairsIfScriptPatched(session, 'script.js');
    assert.ok(session.pendingDomRepairs?.length, 'repairs stay while still broken');
    fs.writeFileSync(path.join(root, 'script.js'), "getElementById('total-income');");
    clearDomRepairsIfScriptPatched(session, 'script.js');
    assert.equal(session.pendingDomRepairs, undefined);
    assert.equal(domContractClean(root), true);
    fs.rmSync(root, { recursive: true, force: true });
});
