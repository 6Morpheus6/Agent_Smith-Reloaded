/**
 * v55.2 regression — "sudo override broke the whole sidebar".
 *
 * The renderer runs in an Electron context with nodeIntegration:false /
 * contextIsolation:true — a pure browser where `require` does not exist. esbuild
 * bundles src/renderer/entry.js for platform:'browser' and leaves node builtins as
 * EXTERNALS, so any top-level require of a builtin (or of a module that requires one)
 * anywhere in the renderer graph becomes a static require("<builtin>") in
 * dist/renderer/bundle.js that throws at load time — killing the ENTIRE bundle: no
 * sidebar, no composer, nothing.
 *
 * The v55.2 sudo work made agentTools.js (renderer) require commandPolicy.js, whose
 * top-level `require('path')` is exactly such an external → "Dynamic require of
 * 'path' is not supported" at load → blank UI. Fix: injectSudoPassword moved to the
 * browser-safe src/shared/sudoInject.js (pure string logic, no builtins);
 * commandPolicy.js re-exports it for main-process consumers.
 *
 * node --check and unit tests can't catch this (the throw happens in the BROWSER at
 * bundle load), so guard both ends statically — same pattern as rendererLoadOrder.test.js:
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE_BUILTINS = ['path', 'fs', 'os', 'http', 'https', 'crypto', 'child_process', 'util', 'stream', 'events', 'url', 'zlib', 'net', 'tls'];

test('renderer bundle contains no static require() of a node builtin (browser context has no require)', () => {
    const bundlePath = path.join(ROOT, 'dist', 'renderer', 'bundle.js');
    assert.ok(fs.existsSync(bundlePath), `missing ${bundlePath} — run: node scripts/build-renderer.js`);
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    for (const b of NODE_BUILTINS) {
        const re = new RegExp(`require\\(\\s*["']${b}["']\\s*\\)`);
        assert.ok(!re.test(bundle), `bundle.js statically requires node builtin "${b}" — it throws at load in the nodeIntegration:false renderer and blanks the whole UI`);
    }
});

test('agentTools.js (renderer) gets injectSudoPassword from the browser-safe sudoInject module', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'modes', 'agentTools.js'), 'utf8');
    assert.match(src, /require\(['"]\.\.\/\.\.\/shared\/sudoInject\.js['"]\)/, 'must require sudoInject.js (no node builtins)');
    assert.ok(!/require\(['"][^'"]*commandPolicy\.js['"]\)/.test(src), 'must NOT require commandPolicy.js — it drags require("path") into the browser bundle');
});

test('sudoInject.js is browser-safe: no node builtin requires, pure function export', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'sudoInject.js'), 'utf8');
    for (const b of NODE_BUILTINS) {
        assert.ok(!new RegExp(`require\\(\\s*["']${b}["']`).test(src), `sudoInject.js must not require "${b}"`);
    }
    const mod = require(path.join(ROOT, 'src', 'shared', 'sudoInject.js'));
    assert.equal(typeof mod.injectSudoPassword, 'function');
});

test('commandPolicy still re-exports injectSudoPassword (main-process API unchanged)', () => {
    const policy = require(path.join(ROOT, 'src', 'shared', 'commandPolicy.js'));
    assert.equal(policy.injectSudoPassword, require(path.join(ROOT, 'src', 'shared', 'sudoInject.js')).injectSudoPassword);
});
