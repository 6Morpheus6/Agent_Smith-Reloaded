// De-hardcoded artifact paths: the harness derives paths from DISK TRUTH (the index.html the
// model actually wrote), not a guessed subdir (pacman/, app/, site/).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedPendingMissingRefs } = require('../src/code/loop/missingRefGuard.js');
const { buildNewArtifactBlock, buildWriteNudge } = require('../src/code/context/artifactHints.js');

test('seedPendingMissingRefs uses the index.html on disk (any folder), not a guessed subdir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'));
    // Model chose its OWN folder name — not pacman/app/site.
    fs.mkdirSync(path.join(root, 'finance-app'));
    fs.writeFileSync(path.join(root, 'finance-app/index.html'),
        '<!doctype html><html><body><script src="main.js"></script></body></html>');
    // main.js is missing on disk
    const session = { projectRoot: root, goal: 'build a budget tracker web app' };
    const missing = seedPendingMissingRefs(session, session.goal);
    assert.deepEqual(missing, ['finance-app/main.js']);
    assert.deepEqual(session.pendingMissingRefs, ['finance-app/main.js']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('seedPendingMissingRefs is host-aware: ignores the host root index.html in an app repo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-host-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: 'main.js', devDependencies: { electron: '^28' } }));
    fs.writeFileSync(path.join(root, 'main.js'), '// host');
    fs.writeFileSync(path.join(root, 'index.html'), '<script src="dist/bundle.js"></script>'); // host index
    fs.mkdirSync(path.join(root, 'my-tracker'));
    fs.writeFileSync(path.join(root, 'my-tracker', 'index.html'), '<script src="app.js"></script>'); // deliverable
    const session = { projectRoot: root, goal: 'build a budget tracker web app' };
    const missing = seedPendingMissingRefs(session, session.goal);
    assert.deepEqual(missing, ['my-tracker/app.js'], 'seeds the deliverable, not the host bundle');
    assert.ok(!missing.includes('dist/bundle.js'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('seedPendingMissingRefs prefers an index.html the model wrote this run (filesTouched)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-touch-'));
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site', 'index.html'), '<script src="main.js"></script>');
    const session = { projectRoot: root, goal: 'build a web app', filesTouched: ['site/index.html'] };
    assert.deepEqual(seedPendingMissingRefs(session, session.goal), ['site/main.js']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('seedPendingMissingRefs seeds nothing when no index.html exists yet', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-empty-'));
    const session = { projectRoot: root, goal: 'build a todo web app' };
    assert.deepEqual(seedPendingMissingRefs(session, session.goal), []);
    assert.equal(session.pendingMissingRefs, undefined);
    fs.rmSync(root, { recursive: true, force: true });
});

test('buildNewArtifactBlock prescribes no fixed subdir (greenfield lets the model choose)', () => {
    const block = buildNewArtifactBlock('Build a Pac-Man game', '/tmp/does-not-matter');
    assert.match(block, /create the files your task needs/i);
    assert.doesNotMatch(block, /pacman\/|app\/index\.html|site\/index\.html/);
});

test('buildWriteNudge prescribes no fixed subdir', () => {
    const nudge = buildWriteNudge('Build a budget tracker web app', '/tmp/x');
    assert.doesNotMatch(nudge, /pacman\/|app\/index\.html|site\/index\.html/);
    assert.match(nudge, /write_file/);
});
