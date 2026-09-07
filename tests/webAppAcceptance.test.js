// Functional acceptance for non-game interactive web apps: an empty shell must fail; a minimal
// working app (responds to input + updates the DOM, plus list/persistence when implied) passes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAcceptance, classifyTask } = require('../src/code/governor/acceptance.js');
const { checkCompletion } = require('../src/code/governor/completionGate.js');

const acc = (goal, html, js) => runAcceptance(goal, { html, js });
const failedIds = (a) => a.failed.map(f => f.id);

test('classifyTask flags CRUD apps but not bare static pages', () => {
    assert.equal(classifyTask('Build a budget tracker web app').isCrudApp, true);
    assert.equal(classifyTask('Build a todo list app').isCrudApp, true);
    assert.equal(classifyTask('Build a kanban board').isCrudApp, true);
    assert.equal(classifyTask('Build a landing page website').isCrudApp, false);
    assert.equal(classifyTask('Build a Pac-Man game').isCrudApp, false); // game, not crud
});

test('empty shell FAILS web-app acceptance', () => {
    const a = acc('Build a todo list web app', '<div id="app"><h1>Todo</h1></div>', 'console.log("todo");');
    assert.equal(a.applicable, true);
    assert.ok(a.failed.length >= 1);
    assert.ok(failedIds(a).includes('interactivity'));
});

test('minimal working todo PASSES', () => {
    const js = 'const items=[];add.addEventListener("click",()=>{items.push(t.value);list.innerHTML=items.map(i=>`<li>${i}</li>`).join("")});';
    const a = acc('Build a todo list web app', '<input id="t"><button id="add">Add</button><ul id="list"></ul>', js);
    assert.deepEqual(a.failed, []);
});

test('minimal working budget tracker PASSES', () => {
    const js = 'let tx=[];addBtn.addEventListener("submit",e=>{e.preventDefault();tx.push(+amt.value);out.textContent=tx.reduce((a,b)=>a+b,0)});';
    const a = acc('Build a personal budget tracker web app', '<form id="addBtn"><input id="amt"></form><div id="out"></div>', js);
    assert.deepEqual(a.failed, []);
});

test('a calculator is NOT force-failed for lacking a list/storage', () => {
    const js = 'let cur="";btn.addEventListener("click",()=>{cur+="1";disp.textContent=cur});';
    const a = acc('Build a calculator web app', '<div id="disp"></div><button id="btn">1</button>', js);
    assert.deepEqual(a.failed, []);
});

test('persistence is required ONLY when the goal asks to save', () => {
    const noStore = 'let tx=[];b.addEventListener("click",()=>{tx.push(1);l.innerHTML=tx.join("")});';
    assert.ok(failedIds(acc('budget tracker that saves to localStorage', '<button id="b"></button><div id="l"></div>', noStore)).includes('persistence'));
    assert.ok(!failedIds(acc('budget tracker web app', '<button id="b"></button><div id="l"></div>', noStore)).includes('persistence'));
});

test('static page is NOT subject to acceptance (no false positive)', () => {
    assert.equal(acc('Build a landing page website', '<h1>Hi</h1>', '').applicable, false);
});

test('gate-level: empty-shell tracker is blocked with [ACCEPT]; working one is not', async () => {
    const mk = (js) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
        fs.writeFileSync(path.join(root, 'index.html'),
            '<!doctype html><html><body><input id="t"><button id="add">Add</button><ul id="list"></ul><script src="app.js"></script></body></html>');
        fs.writeFileSync(path.join(root, 'app.js'), js);
        return root;
    };
    const shell = mk('console.log("tracker");');
    const r1 = await checkCompletion(shell, ['index.html', 'app.js'], 'build an expense tracker web app', { grindMode: false });
    assert.ok((r1.messages || []).some(m => /^\[ACCEPT\]/.test(m)), 'empty shell blocked by acceptance');

    const working = mk('const items=[];add.addEventListener("click",()=>{items.push(t.value);list.innerHTML=items.map(i=>`<li>${i}</li>`).join("")});');
    const r2 = await checkCompletion(working, ['index.html', 'app.js'], 'build an expense tracker web app', { grindMode: false });
    assert.ok(!(r2.messages || []).some(m => /^\[ACCEPT\]/.test(m)), 'working app passes acceptance; got ' + JSON.stringify(r2.messages));

    fs.rmSync(shell, { recursive: true, force: true });
    fs.rmSync(working, { recursive: true, force: true });
});
