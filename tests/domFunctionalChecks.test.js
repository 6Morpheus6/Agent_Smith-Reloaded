// Hardening: required-artifact enforcement, DOM-id/form-control consistency, and the jsdom
// functional smoke — Code Mode must not report `done` when required files are missing or the
// app's DOM contract is broken.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wv = require('../src/code/governor/webValidators.js');
const { checkCompletion } = require('../src/code/governor/completionGate.js');
const { runFunctionalSmoke } = require('../src/code/governor/functionalSmoke.js');

function mkApp(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfc-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}
const WORKING_JS = 'const items=[];const f=document.getElementById("f");const list=document.getElementById("list");'
    + 'f.addEventListener("submit",e=>{e.preventDefault();items.push(f.desc.value);list.innerHTML=items.map(i=>"<li>"+i+"</li>").join("")});';
const WORKING_HTML = '<!doctype html><body><form id="f"><input name="desc"><button type="submit">Add</button></form><ul id="list"></ul><script src="app.js"></script></body>';

// ---- Item 1: required artifacts ----
test('[ARTIFACT] budget tracker prompt missing README.md fails completion', async () => {
    const root = mkApp({ 'index.html': WORKING_HTML, 'app.js': WORKING_JS });
    const goal = 'Build a budget tracker web app with index.html, app.js, and a README.md';
    const r = await checkCompletion(root, ['index.html', 'app.js'], goal, { grindMode: false });
    assert.ok((r.messages || []).some(m => m === '[ARTIFACT] README.md is required by the prompt but missing'));
    assert.equal(r.allow, false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('[ARTIFACT] same prompt passes the artifact check once README.md exists', async () => {
    const root = mkApp({ 'index.html': WORKING_HTML, 'app.js': WORKING_JS, 'README.md': '# Budget Tracker' });
    const goal = 'Build a budget tracker web app with index.html, app.js, and a README.md';
    const r = await checkCompletion(root, ['index.html', 'app.js', 'README.md'], goal, { grindMode: false });
    assert.ok(!(r.messages || []).some(m => /^\[ARTIFACT\]/.test(m)));
    fs.rmSync(root, { recursive: true, force: true });
});

// ---- Item 2: DOM id / form-control consistency ----
test('[DOM] JS references a missing id -> fail, with a "did you mean" suggestion', () => {
    const issues = wv.validateDomIdConsistency({
        html: '<select id="filter-type"></select>',
        js: 'document.getElementById("type-filter").value;'
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /references #type-filter/);
    assert.match(issues[0].message, /did you mean #filter-type/);
});

test('[DOM] JS references an existing id -> pass', () => {
    assert.deepEqual(wv.validateDomIdConsistency({ html: '<div id="app"></div>', js: 'document.getElementById("app");' }), []);
});

test('[DOM] form field access without a matching control -> fail; with name -> pass', () => {
    const bad = wv.validateDomIdConsistency({ html: '<form id="f"><input name="amount"></form>', js: 'const form=document.getElementById("f");form.addEventListener("submit",()=>{const t=form.type;});' });
    assert.ok(bad.some(i => /form\.type/.test(i.message)));
    const ok = wv.validateDomIdConsistency({ html: '<form id="f"><input name="type"><input name="amount"></form>', js: 'const form=document.getElementById("f");form.addEventListener("submit",()=>{const t=form.type;const a=form.amount;});' });
    assert.deepEqual(ok, []);
});

test('[DOM] no false positive on || fallback chains or dynamically-created ids', () => {
    const fallback = wv.validateDomIdConsistency({
        html: '<main id="game-board"></main>',
        js: 'const b=document.getElementById("maze")||document.querySelector(".grid")||document.getElementById("game-board")||document.getElementById("game-container");'
    });
    assert.deepEqual(fallback, []);
    const created = wv.validateDomIdConsistency({ html: '<ul id="l"></ul>', js: 'const r=document.createElement("li");r.id="row-1";document.getElementById("row-1");document.getElementById("l");' });
    assert.deepEqual(created, []);
});

test('[DOM] gate blocks an app whose JS selectors do not match its HTML', async () => {
    const root = mkApp({
        'index.html': '<!doctype html><body><div id="filter-type"></div><script src="app.js"></script></body>',
        'app.js': 'document.getElementById("type-filter").addEventListener("click",()=>{});'
    });
    const r = await checkCompletion(root, ['index.html', 'app.js'], 'build a budget tracker web app', { grindMode: false });
    assert.ok((r.messages || []).some(m => /^\[DOM\].*type-filter/.test(m)));
    fs.rmSync(root, { recursive: true, force: true });
});

// ---- Item 4: functional smoke ----
test('[FUNCTIONAL] working CRUD app (form.namedField) passes the jsdom smoke', async () => {
    const root = mkApp({ 'index.html': WORKING_HTML, 'app.js': WORKING_JS });
    const r = await runFunctionalSmoke({ projectRoot: root, htmlRel: 'index.html', goal: 'build a todo list web app' });
    // jsdom is an optional dep; if present it must PASS a working app (no false positive).
    if (!r.unavailable) assert.deepEqual(r.errors, [], 'working app must pass; got ' + JSON.stringify(r.errors));
    fs.rmSync(root, { recursive: true, force: true });
});

test('[FUNCTIONAL] submit handler that throws is caught; a submit that changes nothing fails', async () => {
    const t = mkApp({ 'index.html': WORKING_HTML, 'app.js': 'const f=document.getElementById("f");f.addEventListener("submit",e=>{e.preventDefault();nope();});' });
    const rt = await runFunctionalSmoke({ projectRoot: t, htmlRel: 'index.html', goal: 'build a todo app' });
    if (!rt.unavailable) assert.equal(rt.ok, false);
    fs.rmSync(t, { recursive: true, force: true });

    const n = mkApp({ 'index.html': WORKING_HTML, 'app.js': 'const f=document.getElementById("f");/* no handler */' });
    const rn = await runFunctionalSmoke({ projectRoot: n, htmlRel: 'index.html', goal: 'build a todo app' });
    if (!rn.unavailable) assert.equal(rn.ok, false);
    fs.rmSync(n, { recursive: true, force: true });
});

test('[FUNCTIONAL] non-interactive goal is skipped (no false failure)', async () => {
    const root = mkApp({ 'index.html': '<h1>Hi</h1>' });
    const r = await runFunctionalSmoke({ projectRoot: root, htmlRel: 'index.html', goal: 'build a landing page' });
    assert.equal(r.skipped, true);
    fs.rmSync(root, { recursive: true, force: true });
});
