const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { serveAndCheck } = require('../src/code/governor/runtimeVerify.js');

function mkproj(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b })); }).on('error', reject);
    });
}

test('serves the project over HTTP with correct MIME (engine can fetch files)', async () => {
    const root = mkproj({ 'index.html': '<h1>hi</h1>', 'src/app.js': 'console.log(1)' });
    let htmlRes, jsRes;
    const engine = async (url) => {
        const base = url.replace(/index\.html$/, '');
        htmlRes = await httpGet(url);
        jsRes = await httpGet(base + 'src/app.js');
        return { errors: [] };
    };
    const r = await serveAndCheck(root, 'index.html', engine);
    assert.equal(r.ok, true);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.type, /text\/html/);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.type, /javascript/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('reports runtime errors from the engine and marks not-ok', async () => {
    const root = mkproj({ 'index.html': '<h1>x</h1>' });
    const engine = async () => ({ errors: ['Uncaught ReferenceError: App is not defined', 'Uncaught ReferenceError: App is not defined'] });
    const r = await serveAndCheck(root, 'index.html', engine);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['Uncaught ReferenceError: App is not defined']); // deduped
    fs.rmSync(root, { recursive: true, force: true });
});

test('ok when engine reports no errors', async () => {
    const root = mkproj({ 'index.html': '<h1>ok</h1>' });
    const r = await serveAndCheck(root, 'index.html', async () => ({ errors: [] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('skipped (never blocks) when no browser engine is injected or it throws', async () => {
    const root = mkproj({ 'index.html': '<h1>x</h1>' });
    assert.equal((await serveAndCheck(root, 'index.html', null)).skipped, true);
    const threw = await serveAndCheck(root, 'index.html', async () => { throw new Error('no chrome'); });
    assert.equal(threw.skipped, true);
    assert.equal(threw.ok, true); // fail-open: never block a run on infra failure
    fs.rmSync(root, { recursive: true, force: true });
});
