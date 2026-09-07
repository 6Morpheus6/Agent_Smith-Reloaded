/**
 * "Build anything" — the completion gate must accept correct projects of ANY kind, not just
 * the narrow web/CRUD shape, and must stop false-blocking correct games/web apps. Guards the
 * audit fixes: smoke browser-global stubs, template-literal scrubbing, serialization-artifact
 * scrubbing, lean game acceptance, and non-web project support.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('../src/code/governor/completionGate.js');
const wv = require('../src/code/governor/webValidators.js');
const { runSmokeTest } = require('../src/code/governor/smokeTest.js');
const { runAcceptance } = require('../src/code/governor/acceptance.js');

function proj(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-any-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}

test('a correct keyboard game (window.addEventListener + UPPERCASE template text) PASSES', async () => {
    const root = proj({
        'index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><div id="game"></div><div id="status"></div><script src="script.js"></script></body></html>',
        'style.css': '#game{width:300px;height:300px}',
        'script.js': [
            "const status = document.getElementById('status');",
            "let score = 0, over = false;",
            "window.addEventListener('keydown', (e) => {",
            "  if (over) return;",
            "  if (e.key === 'ArrowUp') score++;",
            "  status.textContent = `SCORE ${score}`;",
            "  if (score >= 10) { over = true; status.textContent = `GAME OVER you WIN ${score}`; }",
            "});",
            "function loop(){ requestAnimationFrame(loop); }",
            "loop();"
        ].join('\n')
    });
    const r = await gate.checkCompletion(root, ['index.html', 'style.css', 'script.js'], 'Build a simple keyboard game', { grindMode: false });
    assert.equal(r.allow, true, 'correct game must pass; got: ' + r.messages.join(' | '));
    fs.rmSync(root, { recursive: true, force: true });
});

test('a NON-WEB project (Python CLI + README) PASSES the gate', async () => {
    const root = proj({
        'main.py': 'import sys\ndef add(a, b):\n    return a + b\nif __name__ == "__main__":\n    print(add(int(sys.argv[1]), int(sys.argv[2])))\n',
        'README.md': '# Adder CLI\n'
    });
    const r = await gate.checkCompletion(root, ['main.py', 'README.md'], 'Write a Python CLI that adds two numbers, with a README.md', { grindMode: false });
    assert.equal(r.allow, true, 'non-web project must pass; got: ' + r.messages.join(' | '));
    assert.equal(r.status, 'done');
    fs.rmSync(root, { recursive: true, force: true });
});

test('smoke tolerates standard browser globals (window.addEventListener, Audio, navigator, fetch)', () => {
    const root = proj({
        'index.html': '<!doctype html><body><div id="x"></div><script src="app.js"></script></body>',
        'app.js': [
            "window.addEventListener('keydown', () => {});",
            "window.addEventListener('load', () => { document.getElementById('x').textContent = navigator.language; });",
            "const a = new Audio(); const img = new Image();",
            "performance.now(); const m = matchMedia('(max-width: 600px)');",
            "fetch('/data').then(r => r.json());"
        ].join('\n')
    });
    const r = runSmokeTest({ projectRoot: root, indexRel: 'index.html' });
    assert.equal(r.ok, true, 'standard browser idioms must not false-fail the smoke; errors: ' + (r.errors || []).join(' | '));
    fs.rmSync(root, { recursive: true, force: true });
});

test('smoke still catches a genuinely broken script (calling an undefined function)', () => {
    const root = proj({
        'index.html': '<!doctype html><body><script src="app.js"></script></body>',
        'app.js': "totallyUndefinedFunction(42);"
    });
    const r = runSmokeTest({ projectRoot: root, indexRel: 'index.html' });
    assert.equal(r.ok, false, 'a real ReferenceError must still fail the smoke');
    fs.rmSync(root, { recursive: true, force: true });
});

test('findUndefinedConstants ignores template-literal text but still catches real undefined constants', () => {
    assert.deepEqual(wv.findUndefinedConstants("el.textContent = `GAME OVER you WIN ${score}`; let score = 0;"), []);
    assert.deepEqual(wv.findUndefinedConstants("function setSize(WIDTH, HEIGHT){ return WIDTH * HEIGHT; }"), []);
    const real = wv.findUndefinedConstants("if (state === GAME_STATE) {}");
    assert.ok(real.some(i => /GAME_STATE/.test(i.message)), 'a truly undeclared constant must still be flagged');
});

test('detectSerializationArtifacts ignores valid regex/strings but catches real over-escape', () => {
    assert.deepEqual(wv.detectSerializationArtifacts("const re = /^\\{.*\\}$/; if (re.test(x)) {}"), []);
    assert.deepEqual(wv.detectSerializationArtifacts('const s = "a \\{ b \\}";'), []);
    assert.ok(wv.detectSerializationArtifacts("body \\{ color: red; \\}").length > 0, 'real escaped-brace artifact must be flagged');
});

test('game acceptance requires only input+dynamic, not a "player"/score/endstate trope', () => {
    // a real but minimal game: takes input, draws to canvas — no "player" word, no score, no win text
    const good = runAcceptance('Build a drawing game', {
        html: '<canvas id="c"></canvas>',
        js: "const ctx = c.getContext('2d'); window.addEventListener('mousemove', e => ctx.fillRect(e.clientX, e.clientY, 2, 2));"
    });
    assert.equal(good.applicable, true);
    assert.equal(good.failed.length, 0, 'a working interactive game must pass; failed: ' + good.failed.map(c => c.label).join(', '));

    // an empty shell (title only, no interaction) must still fail
    const shell = runAcceptance('Build a snake game', { html: '<h1>Snake</h1><div id="score">0</div>', js: "console.log('todo');" });
    assert.ok(shell.failed.length > 0, 'a non-interactive shell must still be rejected');
});
