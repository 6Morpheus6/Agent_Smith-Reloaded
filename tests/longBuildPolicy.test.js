// v54.5 — long-build policy: packaging commands survive the harness bounds
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    isLongBuildCommand,
    isVerificationCommand,
    clampRequestedTimeout,
    exclusiveBoundFor,
    foregroundTimeoutFor,
    longBuildGuidance,
    DEFAULT_EXCLUSIVE_BOUND_MS
} = require('../src/shared/longBuildPolicy.js');

test('packaging commands are recognized as long builds', () => {
    for (const cmd of [
        'npx electron-builder --linux AppImage deb',
        'npm run dist',
        'electron-builder -l deb',
        'pyinstaller app.spec',
        'make -j4',
        'cargo build --release',
        'docker build -t app .'
    ]) {
        assert.ok(isLongBuildCommand(cmd), `expected long build: ${cmd}`);
    }
});

test('ordinary commands are NOT long builds', () => {
    for (const cmd of ['ls -la', 'node --check script.js', 'git status', 'cat package.json', '', null]) {
        assert.ok(!isLongBuildCommand(cmd), `should not be a build: ${cmd}`);
    }
});

test('build/package runs count as verification (TEST BEFORE DONE)', () => {
    assert.ok(isVerificationCommand('npm run dist'));
    assert.ok(isVerificationCommand('npx electron-builder --linux'));
    assert.ok(isVerificationCommand('pyinstaller app.spec'));
    // classic verification still counts
    assert.ok(isVerificationCommand('npm test'));
    assert.ok(isVerificationCommand('node --check src/app.js'));
    assert.ok(isVerificationCommand('pytest -q'));
    // and noise does not
    assert.ok(!isVerificationCommand('ls -la'));
    assert.ok(!isVerificationCommand('echo packaging notes'));
});

test('timeout_ms is clamped into [1s, ceiling]; junk → null', () => {
    assert.strictEqual(clampRequestedTimeout(60000), 60000);
    assert.strictEqual(clampRequestedTimeout(1), 1000);           // floor
    assert.ok(clampRequestedTimeout(99e9) <= 4 * 3600000);        // ceiling 4h
    assert.strictEqual(clampRequestedTimeout(undefined), null);
    assert.strictEqual(clampRequestedTimeout('abc'), null);
    assert.strictEqual(clampRequestedTimeout(-5), null);
});

test('exclusive bound: recognized build gets the build window, not the flat default', () => {
    const base = DEFAULT_EXCLUSIVE_BOUND_MS;
    const buildBound = exclusiveBoundFor('run_command', { command: 'npx electron-builder --linux' }, base);
    assert.ok(buildBound > base, 'electron-builder must outlive the 5-minute default');

    const plain = exclusiveBoundFor('run_command', { command: 'ls -la' }, base);
    assert.strictEqual(plain, base, 'ordinary commands keep the default bound');

    // explicit timeout_ms wins and both layers agree (shell kills before pipeline rejects)
    const req = { command: 'make', timeout_ms: 90000 };
    const fg = foregroundTimeoutFor('run_command', req, base);
    const ex = exclusiveBoundFor('run_command', req, base);
    assert.strictEqual(fg, 90000);
    assert.ok(ex > fg && ex - fg <= 30000, 'exclusive bound must be slightly larger than the shell timeout');

    // background commands never take an exclusive bound; other tools pass through
    assert.strictEqual(exclusiveBoundFor('run_command', { command: 'make', is_background: true }, base), base);
    assert.strictEqual(exclusiveBoundFor('write_file', {}, base), base);
});

test('timed-out build carries actionable remediation guidance', () => {
    const msg = longBuildGuidance('npx electron-builder --linux AppImage');
    assert.match(msg, /is_background:true/);
    assert.match(msg, /timeout_ms/);
    assert.match(msg, /release\/|dist\//i);
});

test('pipeline honors the per-call bound (integration through runToolPipeline)', async () => {
    const { runToolPipeline } = require('../src/code/tools/pipeline.js');
    // With a tiny base bound, an ordinary command still rejects on time…
    const slow = await runToolPipeline({
        name: 'run_command',
        args: { command: 'sleep 1 && echo done' },
        body: () => new Promise(res => setTimeout(() => res({ exit_code: 0 }), 500)),
        deps: { exclusiveTimeoutMs: 120 }
    });
    assert.ok(slow.error && /timed out/.test(slow.error), `expected timeout, got ${JSON.stringify(slow)}`);

    // …but a recognized long build overrides that base and survives the same body.
    const build = await runToolPipeline({
        name: 'run_command',
        args: { command: 'npx electron-builder --linux AppImage' },
        body: () => new Promise(res => setTimeout(() => res({ exit_code: 0 }), 500)),
        deps: { exclusiveTimeoutMs: 120 }
    });
    assert.strictEqual(build.error, undefined, `long build must outlive the base bound: ${JSON.stringify(build)}`);
});
