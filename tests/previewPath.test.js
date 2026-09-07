/**
 * Preview path validation tests.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectContext = require('../src/main/services/projectContext.js');
const { resolveProjectFile, saveSnapshot, assetPathForId } = require('../src/main/services/previewService.js');
const { validatePreviewAssetPath, validatePreviewUrl } = require('../src/shared/netGuard.js');

test('resolveProjectFile rejects path traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-root-'));
    projectContext.setRoot(root);
    const bad = resolveProjectFile(projectContext, '../../../etc/passwd');
    assert.ok(bad.error);
});

test('resolveProjectFile accepts file in project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-root2-'));
    projectContext.setRoot(root);
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
    const ok = resolveProjectFile(projectContext, 'index.html');
    assert.ok(ok.absPath);
    assert.equal(ok.relPath, 'index.html');
});

test('saveSnapshot writes png and sidecar under userData/previews', async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ud-'));
    const saved = await saveSnapshot(ud, Buffer.from('fakepng'), { kind: 'web_url', target: 'https://example.com' });
    assert.ok(fs.existsSync(saved.pngPath));
    assert.ok(fs.existsSync(saved.jsonPath));
    const valid = validatePreviewAssetPath(saved.pngPath, ud);
    assert.equal(valid, saved.pngPath);
});

test('validatePreviewAssetPath rejects paths outside previews dir', () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ud2-'));
    const outside = path.join(os.tmpdir(), 'evil.png');
    assert.equal(validatePreviewAssetPath(outside, ud), null);
});

test('validatePreviewUrl allows public https and loopback', () => {
    assert.ok(validatePreviewUrl('https://example.com/page'));
    assert.ok(validatePreviewUrl('http://127.0.0.1:5173/'));
    assert.equal(validatePreviewUrl('http://169.254.169.254/'), null);
});

test('assetPathForId only returns paths under previews', () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ud3-'));
    assert.equal(assetPathForId(ud, '../evil', 'png'), null);
});
