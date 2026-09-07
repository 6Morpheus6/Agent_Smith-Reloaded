const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSalvageTruncatedPendingWrite } = require('../src/code/tools/extractor.js');
const {
    tryHarnessScaffold,
    buildPacmanHtmlContent,
    buildPacmanScriptContent,
    buildPacmanStyleContent
} = require('../src/code/loop/harnessScaffold.js');
const { runAcceptance } = require('../src/code/governor/acceptance.js');
const { createDefaultMiddleware, runMiddlewareChain } = require('../src/code/loop/middleware.js');

test('extractSalvageTruncatedPendingWrite recovers truncated JS blob', () => {
    const blob = '{"name":"write_file","parameters":{"path":"pacman/script.js","content":"const score = 0;\\nfunction gameLoop() { score += 1; }\\ndocument.addEventListener(\\"keydown\\", () => {});\\nsetInterval(gameLoop, 100';
    const r = extractSalvageTruncatedPendingWrite(blob, 'pacman/script.js');
    assert.ok(r);
    assert.equal(r.path, 'pacman/script.js');
    assert.match(r.content, /addEventListener/);
    assert.match(r.content, /setInterval/);
});

test('buildPacmanScriptContent passes acceptance heuristics', () => {
    const js = buildPacmanScriptContent();
    assert.match(js, /addEventListener\s*\(\s*['"]keydown/);
    assert.match(js, /setInterval/);
    assert.match(js, /score\s*\+=/);
    assert.match(js, /game over|You win/i);
});

test('buildPacmanHtmlContent links the scaffold stylesheet and script', () => {
    const html = buildPacmanHtmlContent();
    assert.match(html, /href="style\.css"/);
    assert.match(html, /src="script\.js"/);
    assert.match(html, /id="game-board"/);
});

test('buildPacmanStyleContent includes .pacman selector', () => {
    const css = buildPacmanStyleContent();
    assert.match(css, /\.pacman\s*\{/);
    assert.match(css, /\.ghost/);
});

test('tryHarnessScaffold repairs broken existing pac-man artifacts after reflection budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacman-repair-'));
    const dir = path.join(root, 'game');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><link rel="stylesheet" href="style.css"><div id="game-container"></div><script src="script.js"></script></html>');
    fs.writeFileSync(path.join(dir, 'style.css'), '.wall { color: blue; }\n');
    fs.writeFileSync(path.join(dir, 'script.js'), 'function setupInputListeners() {}\n');

    const session = {
        id: 'repair',
        goal: 'create a pac man web browser game',
        projectRoot: root,
        pendingMissingRefs: [],
        filesTouched: ['game/index.html', 'game/style.css', 'game/script.js']
    };

    const result = await tryHarnessScaffold(session, { projectRoot: root }, null, {
        messages: ['[ACCEPT] required capability missing: input handler exists']
    });

    assert.ok(result?.ok);
    assert.equal(result.path, 'game/index.html');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(dir, 'script.js'), 'utf8');
    const acceptance = runAcceptance(session.goal, { html, js });
    assert.deepEqual(acceptance.failed, []);

    fs.rmSync(root, { recursive: true, force: true });
});

test('tryHarnessScaffold writes missing style.css for pac-man goal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacman-css-scaffold-'));
    const dir = path.join(root, 'pacman');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'),
        '<html><link rel="stylesheet" href="style.css"><script src="script.js"></script><div id="maze"></div></html>');
    fs.writeFileSync(path.join(dir, 'script.js'), 'document.addEventListener("keydown",()=>{});\n');

    const session = {
        id: 'test-css',
        goal: 'Build a web based pac-man game',
        projectRoot: root,
        pendingMissingRefs: ['pacman/style.css'],
        filesTouched: ['pacman/index.html', 'pacman/script.js']
    };

    const result = await tryHarnessScaffold(session, { projectRoot: root }, null);
    assert.ok(result?.ok);
    assert.ok(fs.existsSync(path.join(dir, 'style.css')));
    assert.equal(session.pendingMissingRefs, undefined);

    fs.rmSync(root, { recursive: true, force: true });
});

test('tryHarnessScaffold writes missing script.js for pac-man goal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacman-scaffold-'));
    const dir = path.join(root, 'pacman');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><script src="script.js"></script><div id="maze"></div><span id="score">0</span></html>');

    const session = {
        id: 'test',
        goal: 'Create a web based pac-man game and show preview',
        projectRoot: root,
        pendingMissingRefs: ['pacman/script.js'],
        filesTouched: ['pacman/index.html']
    };

    const result = await tryHarnessScaffold(session, { projectRoot: root }, null);
    assert.ok(result?.ok);
    assert.ok(fs.existsSync(path.join(dir, 'script.js')));
    assert.ok(session.filesTouched.includes('pacman/index.html'));
    assert.equal(session.pendingMissingRefs, undefined);

    fs.rmSync(root, { recursive: true, force: true });
});

test('planToolGuard blocks submit_code_plan during executing', async () => {
    const mw = createDefaultMiddleware({});
    const veto = await runMiddlewareChain(mw, 'beforeTool', {
        ctx: {},
        session: { workflow: 'executing', pluginToolNames: [] },
        payload: { name: 'submit_code_plan', args: { goal: 'x', steps: ['a'] }, dup: false }
    });
    assert.equal(veto.veto, true);
    assert.match(veto.result.error, /already approved/i);
});
