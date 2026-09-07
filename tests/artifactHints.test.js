const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    goalImpliesNewArtifacts,
    suggestArtifactSubdir,
    detectAppRepo,
    buildNewArtifactBlock,
    buildWriteNudge,
    buildMissingRefsNudge
} = require('../src/code/context/artifactHints.js');
const { formatGateMessage } = require('../src/code/governor/completionGate.js');
const { extractFromMessage } = require('../src/code/tools/extractor.js');

test('goalImpliesNewArtifacts matches create web game tasks', () => {
    assert.equal(goalImpliesNewArtifacts('Create a web based pac-man game and show preview'), true);
    assert.equal(goalImpliesNewArtifacts('fix the login bug'), false);
});

test('suggestArtifactSubdir picks pacman for pac-man goals', () => {
    assert.equal(suggestArtifactSubdir('Build a Pac-Man clone'), 'pacman');
});

test('detectAppRepo recognizes electron host projects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-app-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: 'main.js' }));
    fs.writeFileSync(path.join(root, 'main.js'), '// electron\n');
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>\n');
    assert.equal(detectAppRepo(root), true);
});

test('buildNewArtifactBlock warns against root index.html in app repos (model chooses layout)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-block-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: 'main.js' }));
    fs.writeFileSync(path.join(root, 'main.js'), '// electron\n');
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>\n');
    const goal = 'Create a web based pac-man game and show preview';
    const block = buildNewArtifactBlock(goal, root);
    assert.match(block, /host app|root index\.html/i);     // warns against the host root
    assert.match(block, /subfolder of your choice/i);       // model picks the path, not a hardcoded one
    assert.match(block, /show_preview/);
    assert.doesNotMatch(block, /pacman\//);                 // no overfit subdir
});

test('buildWriteNudge requires writes without prescribing a subdir', () => {
    const nudge = buildWriteNudge('Create a web based pac-man game and show preview', '/proj');
    assert.match(nudge, /write_file/);
    assert.match(nudge, /show_preview/);
    assert.doesNotMatch(nudge, /pacman\//);                 // model chooses the layout
});

test('formatGateMessage includes artifact hints when no files written', () => {
    const msg = formatGateMessage({
        messages: ['No project files were created or modified yet.']
    }, 'Create a web based pac-man game and show preview', '/proj');
    assert.match(msg, /show_preview/);
    assert.match(msg, /write|create/i);
    assert.doesNotMatch(msg, /pacman\//);
});

test('buildMissingRefsNudge lists each missing file', () => {
    const nudge = buildMissingRefsNudge(['pacman/style.css', 'pacman/script.js'], 'Create pac-man game', '/proj');
    assert.match(nudge, /pacman\/style\.css/);
    assert.match(nudge, /pacman\/script\.js/);
    assert.match(nudge, /write_file/);
});

test('extractor recovers concatenated JSON tool calls', () => {
    const msg = {
        content: '{"name":"read_file","parameters":{"path":"index.html"}}{"name":"write_file","parameters":{"path":"pacman/index.html","content":"<html>"}}'
    };
    const schemas = [
        { function: { name: 'read_file' } },
        { function: { name: 'write_file' } }
    ];
    const r = extractFromMessage(msg, schemas);
    assert.equal(r.addedCalls, 2);
    assert.equal(msg.tool_calls[1].function.name, 'write_file');
});
