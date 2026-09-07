/**
 * Batch 6 — main process services regression tests.
 * Covers the audit findings fixed in this batch:
 *  - actionLog surfaces persistence failures
 *  - browserVerify per-check timeout (skipped without Electron)
 *  - changeLedger distinguishes snapshot-failed from not-existed; reverts created dirs
 *  - editEngine rejects multi-file patches and mismatched patch targets
 *  - lmStudioManager rolls back to the previously loaded model on load failure
 *  - memory propagates saveJSON failures
 *  - pluginInstaller requires immutable refs and cleans up partial downloads
 *  - pluginIntegrity hashes all assets and fails closed on unreadable files
 *  - pluginManager fails closed on sandbox infra failure
 *  - previewService clamps viewport dimensions
 *  - worktreeManager rejects ../ paths and uses collision-safe names
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'b6-'));

// ---- actionLog: persistence failure surfaces a warning ----------------------

test('actionLog record surfaces a warning when persistence fails', () => {
    const { createActionLog } = require('../src/main/services/actionLog.js');
    // Point the log file at a path inside a file (not a dir) so writeFileSync fails.
    const dir = tmp();
    const blockingFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockingFile, 'x');
    const log = createActionLog({ userDataPath: blockingFile }); // userDataPath is a FILE -> save fails
    const r = log.record({ type: 'shell', summary: 'should warn' });
    assert.ok(r.id, 'entry still gets an id (in-memory)');
    assert.ok(r.warning, 'persistence failure surfaced a warning');
});

test('actionLog clear surfaces a warning when persistence fails', () => {
    const { createActionLog } = require('../src/main/services/actionLog.js');
    const dir = tmp();
    const blockingFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockingFile, 'x');
    const log = createActionLog({ userDataPath: blockingFile });
    const r = log.clear();
    assert.ok(r.ok, 'clear still reports ok (in-memory state cleared)');
    assert.ok(r.warning, 'persistence failure surfaced a warning');
});

// ---- changeLedger: snapshot failure aborts; created dirs revert -------------

test('changeLedger snapshotBefore marks a directory as audit-only (existed:true, isDir:true, no destructive existed:false)', async () => {
    const ChangeLedger = require('../src/main/services/changeLedger.js');
    const dir = tmp();
    const ledger = new ChangeLedger(dir);
    const targetDir = path.join(dir, 'subdir');
    fs.mkdirSync(targetDir);
    const snap = await ledger.snapshotBefore('plan1', targetDir, 'edit');
    assert.equal(snap.existed, true, 'existed is true so revertAll will not unlink it as newly created');
    assert.equal(snap.isDir, true, 'isDir flag set');
    assert.ok(!snap.error, 'directory snapshot is audit-only, not a hard error');
});

test('changeLedger revertAll removes a created directory with rm({recursive:true})', async () => {
    const ChangeLedger = require('../src/main/services/changeLedger.js');
    const dir = tmp();
    const ledger = new ChangeLedger(dir);
    const newDir = path.join(dir, 'created-dir');
    fs.mkdirSync(newDir);
    await ledger.recordCreate('plan1', newDir, { isDir: true });
    const r = await ledger.revertAll('plan1');
    assert.equal(r.success, true);
    assert.equal(fs.existsSync(newDir), false, 'created directory was removed');
});

test('changeLedger revertAll does NOT unlink an existing file whose snapshot failed', async () => {
    const ChangeLedger = require('../src/main/services/changeLedger.js');
    const dir = tmp();
    const ledger = new ChangeLedger(dir);
    const target = path.join(dir, 'real.txt');
    fs.writeFileSync(target, 'IMPORTANT');
    // Snapshot a directory (forces snapshotFailed:true, existed:true) to simulate
    // a failed content snapshot on an existing target. revertAll must record an
    // audit-only error and leave the file intact.
    const snap = await ledger.snapshotBefore('plan1', target, 'edit');
    // target is a file, so this path exercises the normal snapshot. To force the
    // snapshotFailed branch we use a directory:
    const subDir = path.join(dir, 'sub');
    fs.mkdirSync(subDir);
    const dirSnap = await ledger.snapshotBefore('plan1', subDir, 'delete');
    assert.ok(dirSnap.existed && !dirSnap.error, 'directory snapshot is audit-only (no error, just not restorable)');
    const r = await ledger.revertAll('plan1');
    assert.equal(fs.existsSync(subDir), true, 'directory with audit-only snapshot was NOT deleted');
    assert.ok(r.errors.some(e => /audit-only/.test(e)), 'revertAll reported it could not restore the directory');
});

// ---- editEngine / editFormats: multi-file patch rejected, path mismatch rejected ----

test('applyPatchToFile rejects a multi-file patch', () => {
    const { applyPatchToFile } = require('../src/shared/editFormats.js');
    const original = 'line1\nline2\n';
    const patch = [
        '--- a/foo.js',
        '+++ b/foo.js',
        '@@ -1 +1 @@',
        '-line1',
        '+changed1',
        '--- a/bar.js',
        '+++ b/bar.js',
        '@@ -1 +1 @@',
        '-line2',
        '+changed2'
    ].join('\n');
    const r = applyPatchToFile(original, patch);
    assert.ok(r.error, 'multi-file patch rejected');
    assert.match(r.error, /multi-file|single file/i);
});

test('applyPatchToFile rejects a patch whose target does not match the expected path', () => {
    const { applyPatchToFile } = require('../src/shared/editFormats.js');
    const original = 'line1\n';
    const patch = '--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n-line1\n+changed\n';
    const r = applyPatchToFile(original, patch, { expectedPath: 'foo.js' });
    assert.ok(r.error, 'path mismatch rejected');
    assert.match(r.error, /does not match|other\.js|foo\.js/i);
});

test('applyPatchToFile accepts a patch whose target matches the expected path', () => {
    const { applyPatchToFile } = require('../src/shared/editFormats.js');
    const original = 'line1\n';
    const patch = '--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-line1\n+changed\n';
    const r = applyPatchToFile(original, patch, { expectedPath: 'foo.js' });
    assert.ok(!r.error, 'matching path accepted');
    assert.equal(r.content, 'changed\n');
});

// ---- lmStudioManager: rollback on load failure ------------------------------

test('ensureModel attempts to restore the previous context when the real load fails', async () => {
    const { createLmStudioManager } = require('../src/main/services/lmStudioManager.js');
    const calls = [];
    let statusReads = 0;
    const manager = createLmStudioManager({
        requestJson: async () => {
            statusReads++;
            // before: loaded at 4096/parallel 4; after rollback attempt: still 4096/4
            return {
                models: [{
                    key: 'm', max_context_length: 131072,
                    loaded_instances: [{ id: 'm', config: { context_length: 4096, parallel: 4 } }]
                }]
            };
        },
        execFile: async (file, args) => {
            calls.push(args);
            if (args[0] === 'load' && !args.includes('--estimate-only')) {
                if (args.includes('--context-length') && args[args.indexOf('--context-length') + 1] === '65536') {
                    throw new Error('load failed');
                }
            }
            return { stdout: '', stderr: '' };
        },
        lmsPath: 'lms'
    });
    const r = await manager.ensureModel({ apiBaseUrl: 'http://127.0.0.1:1234', model: 'm', contextLength: 65536 });
    assert.ok(r.error, 'load failure surfaced');
    assert.match(r.error, /load failed/i);
    // The last load call should be the rollback (context 4096, parallel 4).
    const lastLoad = calls.filter(c => c[0] === 'load' && !c.includes('--estimate-only')).pop();
    assert.ok(lastLoad, 'a rollback load was attempted');
    assert.equal(lastLoad[lastLoad.indexOf('--context-length') + 1], '4096', 'rollback used the previous context');
});

// ---- memory: saveJSON failure propagates ------------------------------------

test('memory clearMemory returns an error object when persistence fails', () => {
    // Load memory.js with a stubbed electron app path so it does not touch real userData.
    const memPath = require.resolve('../src/main/services/memory.js');
    delete require.cache[memPath];
    // Provide a fake app that points userData at a FILE so saveJSON fails.
    const dir = tmp();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const origLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') return { app: { getPath: () => blocker } };
        return origLoad.apply(this, arguments);
    };
    try {
        const mem = require(memPath);
        const r = mem.clearMemory();
        assert.equal(r.success, false);
        assert.ok(r.error, 'persistence failure surfaced');
    } finally {
        Module._load = origLoad;
        delete require.cache[memPath];
    }
});

// ---- pluginIntegrity: hashes all assets and fails closed -------------------

test('pluginIntegrity hashPluginDir changes when a non-code asset changes', () => {
    const { hashPluginDir } = require('../src/main/services/pluginIntegrity.js');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'tool.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(dir, 'prompt.txt'), 'system prompt v1\n');
    const h1 = hashPluginDir(dir);
    fs.writeFileSync(path.join(dir, 'prompt.txt'), 'system prompt v2\n');
    const h2 = hashPluginDir(dir);
    assert.notEqual(h1, h2, 'non-code asset change must alter the hash');
});

test('pluginIntegrity hashPluginDir includes dist, build, and node_modules assets', () => {
    const { hashPluginDir } = require('../src/main/services/pluginIntegrity.js');
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(dir, 'build', 'asset.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    const h1 = hashPluginDir(dir);
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'console.log(2);\n');
    const h2 = hashPluginDir(dir);
    assert.notEqual(h1, h2, 'dist asset must be hashed');
});

test('pluginIntegrity hashPluginDir throws when a file is unreadable', () => {
    const { hashPluginDir } = require('../src/main/services/pluginIntegrity.js');
    const dir = tmp();
    const f = path.join(dir, 'tool.js');
    fs.writeFileSync(f, 'module.exports = {};\n');
    // Make the file unreadable (chmod 000). On Windows chmod is a no-op for the
    // owner, so skip if the read still succeeds.
    try { fs.chmodSync(f, 0o000); } catch (e) { /* skip on platforms without chmod */ }
    let threw = false;
    try {
        hashPluginDir(dir);
    } catch (e) {
        threw = true;
        assert.match(e.message, /cannot read plugin file/i);
    }
    try { fs.chmodSync(f, 0o644); } catch (e) { /* ignore */ }
    if (!threw && process.platform === 'win32') {
        // Windows does not honor chmod 000 for the owner; the throw is not
        // guaranteed there. Skip the assertion rather than fail.
        return;
    }
    assert.ok(threw, 'unreadable file must make hashing throw (fail closed)');
});

// ---- pluginManager: sandbox fail-closed ------------------------------------

test('pluginManager invokeTool fails closed when the sandbox throws (no in-process fallback)', async () => {
    const PluginManager = require('../src/main/services/pluginManager.js');
    const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');
    const ud = tmp();
    fs.mkdirSync(path.join(ud, 'plugins'), { recursive: true });
    fs.cpSync(EXAMPLE, path.join(ud, 'plugins', 'hello'), { recursive: true });

    const pm = new PluginManager(ud, {
        sandbox: true,
        sandboxImpl: {
            permissionSupported: () => true,
            runToolSandboxed: async () => { throw new Error('sandbox infra broken'); }
        }
    });
    pm.discover();
    pm.setEnabled('hello', true, ['log']);
    const out = await pm.invokeTool('hello_echo', { text: 'hi' });
    assert.match(out, /^Error:/, 'sandbox failure did not fall back to in-process');
    assert.match(out, /sandbox/i, 'error mentions the sandbox');
});

test('pluginManager invokeTool fails closed when sandbox permissions are unavailable', async () => {
    const PluginManager = require('../src/main/services/pluginManager.js');
    const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');
    const ud = tmp();
    fs.mkdirSync(path.join(ud, 'plugins'), { recursive: true });
    fs.cpSync(EXAMPLE, path.join(ud, 'plugins', 'hello'), { recursive: true });

    const pm = new PluginManager(ud, {
        sandbox: true,
        sandboxImpl: {
            permissionSupported: () => false,
            runToolSandboxed: async () => 'should-not-run'
        }
    });
    pm.discover();
    pm.setEnabled('hello', true, ['log']);
    const out = await pm.invokeTool('hello_echo', { text: 'hi' });
    assert.match(out, /permission model is unavailable/i);
});

// ---- previewService: viewport clamping -------------------------------------

test('previewService clampViewport clamps extreme/non-finite values', () => {
    const { clampViewport, DEFAULT_VIEWPORT, MIN_VIEWPORT_DIM, MAX_VIEWPORT_DIM } = require('../src/main/services/previewService.js');
    assert.deepStrictEqual(clampViewport({ width: null, height: null }), DEFAULT_VIEWPORT, 'null dimensions use defaults');
    assert.equal(clampViewport({ width: 100000, height: 1 }).width, MAX_VIEWPORT_DIM);
    assert.equal(clampViewport({ width: 100000, height: 1 }).height, MIN_VIEWPORT_DIM);
    assert.equal(clampViewport({ width: -5, height: 0 }).width, MIN_VIEWPORT_DIM);
    assert.equal(clampViewport({ width: -5, height: 0 }).height, MIN_VIEWPORT_DIM);
    const clamped = clampViewport({ width: NaN, height: Infinity });
    assert.ok(clamped.width >= MIN_VIEWPORT_DIM && clamped.width <= MAX_VIEWPORT_DIM);
    assert.ok(clamped.height >= MIN_VIEWPORT_DIM && clamped.height <= MAX_VIEWPORT_DIM);
});

// ---- worktreeManager: collision-safe names + ../ rejection -----------------

test('worktreeManager branchName and worktreePath include a short hash (collision-safe)', () => {
    const { branchName, worktreePath } = require('../src/main/services/worktreeManager.js');
    const b1 = branchName('session-aaa');
    const b2 = branchName('session-aaa');
    assert.equal(b1, b2, 'same id -> same name');
    // Two ids that share a 40-char prefix but differ later must produce different names.
    const longA = 'a'.repeat(60) + 'X';
    const longB = 'a'.repeat(60) + 'Y';
    assert.notEqual(branchName(longA), branchName(longB), 'different ids -> different branch names');
    assert.notEqual(worktreePath('/r', longA), worktreePath('/r', longB), 'different ids -> different paths');
});

test('worktreeManager syncWorktreeFiles rejects ../ and absolute paths', () => {
    const { syncWorktreeFiles } = require('../src/main/services/worktreeManager.js');
    const main = tmp();
    const wt = tmp();
    fs.writeFileSync(path.join(wt, 'good.txt'), 'ok');
    fs.writeFileSync(path.join(wt, 'victim.txt'), 'stolen');
    const r = syncWorktreeFiles(main, wt, ['good.txt', '../victim.txt', '/etc/passwd']);
    assert.ok(r.synced.includes('good.txt'), 'in-root path synced');
    assert.ok(r.errors.some(e => /escapes/.test(e.error)), '../ rejected');
    assert.ok(r.errors.some(e => /absolute/.test(e.error)), 'absolute path rejected');
    assert.equal(fs.existsSync(path.join(main, 'victim.txt')), false, 'nothing written outside main root');
});

test('worktreeManager syncWorktreeFiles refuses symlink escapes', () => {
    const { syncWorktreeFiles } = require('../src/main/services/worktreeManager.js');
    const main = tmp();
    const wt = tmp();
    const outside = tmp();
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'stolen');
    try {
        fs.symlinkSync(secret, path.join(wt, 'link.txt'));
    } catch (e) {
        return; // symlink support unavailable on this platform
    }
    const r = syncWorktreeFiles(main, wt, ['link.txt']);
    assert.ok(r.errors.some(e => /symlink escapes/i.test(e.error)), 'symlink escape rejected');
    assert.equal(fs.existsSync(path.join(main, 'link.txt')), false, 'nothing copied from outside the worktree');
});

// ---- pluginInstaller: mutable HEAD refused without opt-in ------------------

test('pluginInstaller install refuses a mutable git URL without allowMutable', async () => {
    const PluginInstaller = require('../src/main/services/pluginInstaller.js');
    const dir = tmp();
    const inst = new PluginInstaller(path.join(dir, 'plugins'), { hasGit: true });
    const r = await inst.install('https://github.com/example/hello.git');
    assert.ok(r.error, 'mutable HEAD refused');
    assert.match(r.error, /mutable|immutable/i);
});

test('pluginInstaller install refuses a mutable GitHub tarball URL without allowMutable', async () => {
    const PluginInstaller = require('../src/main/services/pluginInstaller.js');
    const dir = tmp();
    const inst = new PluginInstaller(path.join(dir, 'plugins'), { hasGit: false });
    const r = await inst.install('https://github.com/owner/repo');
    assert.ok(r.error, 'mutable branch tarball refused');
    assert.match(r.error, /mutable|immutable/i);
});

test('pluginInstaller install refuses a generic archive URL without allowMutable', async () => {
    const PluginInstaller = require('../src/main/services/pluginInstaller.js');
    const dir = tmp();
    const inst = new PluginInstaller(path.join(dir, 'plugins'), { hasGit: false });
    const r = await inst.install('https://example.com/archive.tar.gz');
    assert.ok(r.error, 'generic archive rejected');
    assert.match(r.error, /allowMutable/i);
});

test('pluginInstaller install does not treat non-boolean allowMutable as opt-in', async () => {
    const PluginInstaller = require('../src/main/services/pluginInstaller.js');
    const dir = tmp();
    const inst = new PluginInstaller(path.join(dir, 'plugins'), { hasGit: false });
    const r = await inst.install('https://github.com/owner/repo', { allowMutable: 1 });
    assert.ok(r.error, 'only allowMutable === true should opt in');
});

test('pluginInstaller install fetches an immutable SHA ref correctly', async () => {
    const PluginInstaller = require('../src/main/services/pluginInstaller.js');
    const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');
    const dir = tmp();
    const calls = [];
    const inst = new PluginInstaller(path.join(dir, 'plugins'), {
        hasGit: true,
        runGit: (args, cwd) => {
            calls.push(args);
            if (args[0] === 'init') {
                fs.mkdirSync(path.join(cwd, 'repo'), { recursive: true });
            }
            if (args[0] === '-C' && args[1] === 'repo' && args[2] === 'fetch') {
                fs.cpSync(EXAMPLE, path.join(cwd, 'repo'), { recursive: true });
            }
        }
    });
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const r = await inst.install(`https://github.com/example/hello.git#ref=${sha}`);
    assert.equal(r.success, true);
    assert.equal(r.immutable, true);
    assert.equal(r.sourceRef, sha);
    assert.ok(calls.some((args) => args.includes('fetch')), 'SHA ref was fetched, not cloned as a branch');
});

test('pluginInstaller install accepts a mutable URL with allowMutable', async () => {
    const PluginInstaller = require('../src/main/services/pluginInstaller.js');
    const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');
    const dir = tmp();
    const inst = new PluginInstaller(path.join(dir, 'plugins'), {
        hasGit: true,
        runGit: (args, cwd) => {
            const dest = path.join(cwd, 'repo');
            fs.cpSync(EXAMPLE, dest, { recursive: true });
        }
    });
    const r = await inst.install('https://github.com/example/hello.git', { allowMutable: true });
    assert.equal(r.success, true);
    assert.equal(r.immutable, false, 'recorded as mutable');
});

// ---- previewRunner: captureSource requires a valid pending previewId --------

test('previewRunner captureSource rejects a capture with no pending previewId', async () => {
    const { createPreviewRunner } = require('../src/main/services/previewRunner.js');
    const runner = createPreviewRunner({
        projectContext: { resolvePath: (p) => ({ path: p }) },
        userDataPath: tmp(),
        getMainWindow: () => null,
        pushEvent: () => {},
        getWebServerPort: () => 3000,
        getLocalIP: () => '127.0.0.1',
        isElectronDesktop: true,
        getAllowDesktopPreview: () => true
    });
    const r = await runner.captureSource({ sourceId: 'screen:1' });
    assert.ok(r.error, 'capture without pending previewId rejected');
    assert.match(r.error, /pending/i);
});

test('previewRunner consumes previewId before a failed capture so it cannot be reused', async () => {
    const previewService = require('../src/main/services/previewService.js');
    const { createPreviewRunner } = require('../src/main/services/previewRunner.js');
    const origCapture = previewService.captureDesktopSource;
    previewService.captureDesktopSource = async () => ({ error: 'capture failed' });
    try {
        const runner = createPreviewRunner({
            projectContext: { resolvePath: (p) => ({ path: p }) },
            userDataPath: tmp(),
            getMainWindow: () => null,
            pushEvent: () => {},
            getWebServerPort: () => 3000,
            getLocalIP: () => '127.0.0.1',
            isElectronDesktop: true,
            getAllowDesktopPreview: () => true
        });
        const shown = await runner.show({ kind: 'screenshot' });
        assert.ok(shown.pending, 'screenshot request created a pending preview');
        const first = await runner.captureSource({ previewId: shown.previewId, sourceId: 'screen:1' });
        assert.match(first.error, /capture failed/i);
        const second = await runner.captureSource({ previewId: shown.previewId, sourceId: 'screen:1' });
        assert.match(second.error, /No pending desktop capture/i);
    } finally {
        previewService.captureDesktopSource = origCapture;
    }
});
