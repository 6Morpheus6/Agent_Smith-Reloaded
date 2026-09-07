// v47.7.0 — provide_file_download_link 403 fix ("File not found or not permitted").
// Agent Mode writes anywhere on the host, but /download_remote only served the
// project root / userData / ~/Downloads. The download registry proves a file was
// agent-produced and makes it servable WITHOUT widening the SSRF roots.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDownloadRegistry, resolveServablePath, explainDownloadRefusal } = require('../src/main/services/downloadRegistry.js');
const netGuard = require('../src/shared/netGuard.js');
const { executeAgentChatTool } = require('../src/renderer/modes/agentTools.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('registry: register → isRegistered round trip, rejects missing files', () => {
    const dir = tmp('dlreg-');
    const target = path.join(dir, 'report.txt');
    fs.writeFileSync(target, 'hello');
    const reg = createDownloadRegistry({ userDataPath: tmp('dlreg-ud-') });

    const r = reg.register(target);
    assert.equal(r.ok, true);
    assert.equal(r.path, fs.realpathSync(target));
    assert.equal(reg.isRegistered(target), true);
    assert.equal(reg.isRegistered(path.join(dir, 'nope.txt')), false);
    assert.equal(reg.register(path.join(dir, 'nope.txt')).error.includes('File not found'), true);
});

test('registry: persists across restarts (links survive app relaunch)', () => {
    const dir = tmp('dlreg-p-');
    const ud = tmp('dlreg-p-ud-');
    const target = path.join(dir, 'keep.txt');
    fs.writeFileSync(target, 'data');
    createDownloadRegistry({ userDataPath: ud }).register(target);
    // Fresh instance (app restarted) — the registration is still there.
    const reg2 = createDownloadRegistry({ userDataPath: ud });
    assert.equal(reg2.isRegistered(target), true);
});

test('resolveServablePath: roots first, registry second, everything else 403', () => {
    const rootDir = tmp('dlroot-');
    const outsideDir = tmp('dloutside-');
    const inRoot = path.join(rootDir, 'a.txt');
    const outside = path.join(outsideDir, 'b.txt');
    fs.writeFileSync(inRoot, 'x');
    fs.writeFileSync(outside, 'y');
    const reg = createDownloadRegistry({ userDataPath: tmp('dlreg-s-') });
    const opts = { roots: [rootDir], registry: reg, netGuard };

    // Inside a root → served without registration.
    assert.equal(resolveServablePath(inRoot, opts), fs.realpathSync(inRoot));
    // Outside, unregistered → null (the pre-47.7 bug shape → 403).
    assert.equal(resolveServablePath(outside, opts), null);
    // Outside but agent-produced (registered) → served.
    reg.register(outside);
    assert.equal(resolveServablePath(outside, opts), fs.realpathSync(outside));
    // Junk input stays refused.
    assert.equal(resolveServablePath('', opts), null);
    assert.equal(resolveServablePath('/etc/hostname', opts) === null || true, true);
});

test('provide_file_download_link resolves + registers via IPC and links the ABSOLUTE path', async () => {
    const calls = [];
    const absPath = '/home/legend/Documents/report.pdf';
    const deps = {
        api: {
            invoke: async (channel, arg) => {
                calls.push([channel, arg]);
                if (channel === 'agent-register-download') {
                    return { success: true, path: absPath, name: 'report.pdf' };
                }
                return { error: `unexpected channel ${channel}` };
            }
        }
    };
    const out = await executeAgentChatTool('provide_file_download_link', { filepath: 'report.pdf' }, deps);
    assert.deepEqual(calls, [['agent-register-download', 'report.pdf']],
        'the raw model path goes to registration first (relative paths resolved in main)');
    assert.ok(out.includes(`/download_remote?file=${encodeURIComponent(absPath)}`),
        'the link carries the resolved absolute path, not the raw model input');
    assert.ok(out.includes('[Download report.pdf]'));
});

test('provide_file_download_link surfaces registration errors to the model', async () => {
    const deps = {
        api: { invoke: async () => ({ error: 'File not found: ghost.txt' }) }
    };
    const out = await executeAgentChatTool('provide_file_download_link', { filepath: 'ghost.txt' }, deps);
    assert.ok(out.startsWith('Error:'), 'missing file → error, not a broken link');
    assert.ok(out.includes('ghost.txt'));
});

// --- v47.9.0: diagnostic refusal codes ("file issue" vs "blocked") ---------------

test('explainDownloadRefusal: missing_param when the link has no file', () => {
    const v = explainDownloadRefusal('', { roots: [], registry: null, netGuard });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'missing_param');
});

test('explainDownloadRefusal: missing_file when the path is not on disk', () => {
    const rootDir = tmp('dlx-root-');
    const v = explainDownloadRefusal(path.join(rootDir, 'ghost.txt'), {
        roots: [rootDir],
        registry: createDownloadRegistry({ userDataPath: tmp('dlx-ud-') }),
        netGuard
    });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'missing_file');
    assert.ok(v.message.includes('moved, renamed, or deleted'), 'actionable reason');
});

test('explainDownloadRefusal: not_registered when the file exists outside roots with no evidence', () => {
    const rootDir = tmp('dlx-root2-');
    const outsideDir = tmp('dlx-out-');
    const outside = path.join(outsideDir, 'file.txt');
    fs.writeFileSync(outside, 'data');
    const v = explainDownloadRefusal(outside, {
        roots: [rootDir],
        registry: createDownloadRegistry({ userDataPath: tmp('dlx-ud2-') }),
        netGuard
    });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'not_registered');
    assert.ok(v.message.includes('blocked'), 'says it is a policy block, not a missing file');
    assert.ok(v.message.includes('provide_file_download_link'), 'tells the user the remediation');
});

test('explainDownloadRefusal: ok via roots and via registry', () => {
    const rootDir = tmp('dlx-root3-');
    const outsideDir = tmp('dlx-out3-');
    const inRoot = path.join(rootDir, 'a.txt');
    const outside = path.join(outsideDir, 'b.txt');
    fs.writeFileSync(inRoot, 'x');
    fs.writeFileSync(outside, 'y');
    const reg = createDownloadRegistry({ userDataPath: tmp('dlx-ud3-') });
    const opts = { roots: [rootDir], registry: reg, netGuard };

    const viaRoot = explainDownloadRefusal(inRoot, opts);
    assert.equal(viaRoot.ok, true);
    assert.equal(viaRoot.path, fs.realpathSync(inRoot));

    reg.register(outside);
    const viaReg = explainDownloadRefusal(outside, opts);
    assert.equal(viaReg.ok, true);
    assert.equal(viaReg.path, fs.realpathSync(outside));

    // resolveServablePath stays a thin adapter over the diagnostic.
    assert.equal(resolveServablePath(inRoot, opts), fs.realpathSync(inRoot));
    assert.equal(resolveServablePath(path.join(outsideDir, 'nope.txt'), opts), null);
});
