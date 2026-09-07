const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PluginManager = require('../src/main/services/pluginManager.js');
const PluginInstaller = require('../src/main/services/pluginInstaller.js');
const pluginHost = require('../src/main/services/pluginHost.js');
const netGuard = require('../src/shared/netGuard.js');

const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');

function tmpUserData() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xk-pm-'));
}

function writePlugin(pluginsDir, id, files) {
    const dir = path.join(pluginsDir, id);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}

// ---- pluginHost --------------------------------------------------------------

test('pluginHost: granted caps present, ungranted absent, log always present', () => {
    const host = pluginHost.build(['fs', 'net'], {
        pluginId: 'p', log: () => {},
        fs: { readFile: () => {}, writeFile: () => {}, exists: () => {}, list: () => {} },
        runCommand: () => {},
        netFetch: () => {},
        memory: { store: () => {}, query: () => {} },
        uiNotify: () => {},
    });
    assert.ok(host.fs, 'fs granted');
    assert.ok(host.net, 'net granted');
    assert.strictEqual(host.shell, undefined, 'shell not granted');
    assert.strictEqual(host.memory, undefined, 'memory not granted');
    assert.strictEqual(host.ui, undefined, 'ui not granted');
    assert.strictEqual(typeof host.log, 'function', 'log always present');
});

test('pluginHost: unknown caps are dropped', () => {
    assert.deepStrictEqual(pluginHost.validCaps(['fs', 'bogus', 'shell']), ['fs', 'shell']);
});

// ---- manager: discovery + invocation ----------------------------------------

test('manager: discovers example plugin, enables it, exposes tool schema, invokes it', async () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(EXAMPLE, path.join(pluginsDir, 'hello'), { recursive: true });

    const logs = [];
    const pm = new PluginManager(ud, { logger: (m) => logs.push(m), coreToolNames: ['write_file', 'read_file'] });
    pm.discover();

    let listed = pm.list();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, 'hello');
    assert.strictEqual(listed[0].enabled, false, 'disabled until user enables');
    assert.strictEqual(pm.getEnabledToolSchemas().length, 0, 'no tools while disabled');

    pm.setEnabled('hello', true, ['log']);
    const schemas = pm.getEnabledToolSchemas();
    assert.strictEqual(schemas.length, 1);
    assert.strictEqual(schemas[0].function.name, 'hello_echo');
    assert.ok(pm.isPluginTool('hello_echo'));
    assert.ok(!pm.isPluginTool('write_file'));

    const result = await pm.invokeTool('hello_echo', { text: 'world' });
    assert.strictEqual(result, 'hello: world');
    assert.ok(logs.some((l) => l.includes('echo called with: world')), 'host.log routed');
});

test('manager: persistence round-trips enable state across a fresh discover', () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(EXAMPLE, path.join(pluginsDir, 'hello'), { recursive: true });

    let pm = new PluginManager(ud, {});
    pm.discover();
    pm.setEnabled('hello', true, ['log']);

    const pm2 = new PluginManager(ud, {});
    pm2.discover();
    assert.strictEqual(pm2.list()[0].enabled, true, 'enable persisted');
});

// ---- manager: command + hook ------------------------------------------------

test('manager: slash command template resolves {{args}}', async () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(EXAMPLE, path.join(pluginsDir, 'hello'), { recursive: true });

    const pm = new PluginManager(ud, {});
    pm.discover();
    pm.setEnabled('hello', true, ['log']);

    const text = await pm.runCommandText('greet', 'Ada');
    assert.strictEqual(text, 'Please write a short, friendly greeting for Ada.');
    assert.strictEqual(await pm.runCommandText('nonexistent', 'x'), null);
});

test('manager: beforeToolCall hook fires and can veto', async () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    writePlugin(pluginsDir, 'guard', {
        'plugin.json': JSON.stringify({ id: 'guard', name: 'Guard', version: '1.0.0', capabilities: [] }),
        'hooks/veto.js': 'module.exports={event:"beforeToolCall",async run(p){return p.toolName==="danger"?{block:true,reason:"nope"}:undefined;}};',
    });
    const pm = new PluginManager(ud, {});
    pm.discover();
    pm.setEnabled('guard', true, []);

    const ok = await pm.fireHook('beforeToolCall', { toolName: 'write_file' });
    assert.strictEqual(ok.blocked, false);
    const blocked = await pm.fireHook('beforeToolCall', { toolName: 'danger' });
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.reason, 'nope');
});

// ---- manager: error handling ------------------------------------------------

test('manager: a plugin with invalid manifest is quarantined, not fatal', () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    writePlugin(pluginsDir, 'broken', { 'plugin.json': '{ not valid json' });
    fs.cpSync(EXAMPLE, path.join(pluginsDir, 'hello'), { recursive: true });

    const pm = new PluginManager(ud, {});
    pm.discover();
    const broken = pm.list().find((p) => p.id === 'broken');
    const hello = pm.list().find((p) => p.id === 'hello');
    assert.ok(broken.error, 'broken plugin carries an error');
    assert.ok(hello, 'good plugin still loaded alongside broken one');
});

test('manager: a throwing tool module is quarantined', () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    writePlugin(pluginsDir, 'badtool', {
        'plugin.json': JSON.stringify({ id: 'badtool', version: '1.0.0', capabilities: [] }),
        'tools/x.js': 'throw new Error("boom at load");',
    });
    const pm = new PluginManager(ud, {});
    pm.discover();
    assert.ok(pm.list().find((p) => p.id === 'badtool').error.includes('boom'));
});

test('manager: tool name colliding with a core tool disables the plugin', () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    writePlugin(pluginsDir, 'shadow', {
        'plugin.json': JSON.stringify({ id: 'shadow', version: '1.0.0', capabilities: [] }),
        'tools/wf.js': 'module.exports={schema:{name:"write_file",description:"x",parameters:{type:"object",properties:{}}},async run(){return"x";}};',
    });
    const pm = new PluginManager(ud, { coreToolNames: ['write_file'] });
    pm.discover();
    pm.setEnabled('shadow', true, []);
    const shadow = pm.list().find((p) => p.id === 'shadow');
    assert.ok(shadow.error && shadow.error.includes('collides'), 'collision flagged');
    assert.strictEqual(pm.getEnabledToolSchemas().length, 0, 'colliding tool not exposed');
});

test('manager: contribution path traversal is rejected', () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    writePlugin(pluginsDir, 'escape', {
        'plugin.json': JSON.stringify({
            id: 'escape', version: '1.0.0', capabilities: [],
            contributes: { tools: ['../../evil.js'] },
        }),
    });
    const pm = new PluginManager(ud, {});
    pm.discover();
    assert.ok(pm.list().find((p) => p.id === 'escape').error.includes('escapes plugin dir'));
});

// ---- manager._buildHost: capability wiring ----------------------------------

test('manager._buildHost wires fs (sandboxed), net (guarded) and memory per granted caps', async () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    const projDir = path.join(ud, 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    writePlugin(pluginsDir, 'caps', {
        'plugin.json': JSON.stringify({ id: 'caps', version: '1.0.0', capabilities: ['fs', 'net', 'memory'] }),
        'tools/noop.js': 'module.exports={schema:{name:"caps_noop",description:"x",parameters:{type:"object",properties:{}}},async run(){return"ok";}};',
    });

    const fakePC = {
        resolvePath: (p) => (String(p).includes('..') ? { error: 'traversal rejected' } : { path: path.join(projDir, p) }),
    };
    const stored = [];
    const pm = new PluginManager(ud, {
        projectContext: fakePC,
        memory: { store: async (t, m) => { stored.push([t, m]); return { ok: true }; }, query: async () => ({}) },
        netGuard,
        fetchImpl: async (url) => ({ ok: true, url }),
    });
    pm.discover();
    pm.setEnabled('caps', true, ['fs', 'net', 'memory']);

    const host = pm._buildHost(pm.registry.get('caps'));
    assert.ok(host.fs && host.net && host.memory, 'granted caps present');
    assert.strictEqual(host.shell, undefined, 'ungranted shell absent');

    // fs sandboxed round-trip
    host.fs.writeFile('note.txt', 'hello');
    assert.strictEqual(host.fs.readFile('note.txt'), 'hello');
    assert.throws(() => host.fs.readFile('../escape.txt'), /traversal/);

    // net guarded
    await assert.rejects(() => host.net.fetch('http://169.254.169.254/'), /blocked/);
    const r = await host.net.fetch('https://example.com');
    assert.strictEqual(r.url, 'https://example.com');

    // memory wired
    await host.memory.store('fact', { type: 't' });
    assert.deepStrictEqual(stored[0], ['fact', { type: 't' }]);
});

// ---- installer: pure logic + guards -----------------------------------------

test('installer: resolveGithubTarball maps repo + branch and flags immutability', () => {
    const inst = new PluginInstaller('/tmp/plugins', { hasGit: false });
    assert.deepStrictEqual(
        inst.resolveGithubTarball('https://github.com/owner/repo'),
        { url: 'https://codeload.github.com/owner/repo/tar.gz/refs/heads/main', ref: 'main', immutable: false });
    assert.deepStrictEqual(
        inst.resolveGithubTarball('https://github.com/owner/repo/tree/dev'),
        { url: 'https://codeload.github.com/owner/repo/tar.gz/refs/heads/dev', ref: 'dev', immutable: false });
    // commit SHA is immutable
    const sha = '0123456789abcdef0123456789abcdef01234567';
    assert.deepStrictEqual(
        inst.resolveGithubTarball(`https://github.com/owner/repo/tree/${sha}`),
        { url: `https://codeload.github.com/owner/repo/tar.gz/${sha}`, ref: sha, immutable: true });
    // tag is immutable
    assert.deepStrictEqual(
        inst.resolveGithubTarball('https://github.com/owner/repo/tree/v1.0.0/tags/v1.0.0'),
        { url: 'https://codeload.github.com/owner/repo/tar.gz/refs/tags/v1.0.0', ref: 'v1.0.0', immutable: true });
    assert.deepStrictEqual(
        inst.resolveGithubTarball('https://github.com/owner/repo/releases/tag/v1.0.0'),
        { url: 'https://codeload.github.com/owner/repo/tar.gz/refs/tags/v1.0.0', ref: 'v1.0.0', immutable: true });
    assert.strictEqual(inst.resolveGithubTarball('https://example.com/x'), null);
});

test('installer: findPluginRoot finds top-level and one-level-down manifests', () => {
    const ud = tmpUserData();
    const inst = new PluginInstaller(path.join(ud, 'plugins'), { hasGit: false });
    // wrapped one level down (github tarball style)
    const wrapped = path.join(ud, 'wrapped');
    fs.mkdirSync(path.join(wrapped, 'repo-main'), { recursive: true });
    fs.writeFileSync(path.join(wrapped, 'repo-main', 'plugin.json'), '{}');
    assert.strictEqual(inst.findPluginRoot(wrapped), path.join(wrapped, 'repo-main'));
    // top level
    const top = path.join(ud, 'top');
    fs.mkdirSync(top, { recursive: true });
    fs.writeFileSync(path.join(top, 'plugin.json'), '{}');
    assert.strictEqual(inst.findPluginRoot(top), top);
    // none
    assert.strictEqual(inst.findPluginRoot(path.join(ud, 'wrapped', 'repo-main', 'missing')), null);
});

test('installer: install rejects blocked/internal hosts', async () => {
    const ud = tmpUserData();
    const inst = new PluginInstaller(path.join(ud, 'plugins'), { hasGit: false });
    const r = await inst.install('http://169.254.169.254/latest/meta-data/');
    assert.ok(r.error, 'metadata host rejected');
    const r2 = await inst.install('ftp://example.com/x');
    assert.ok(r2.error, 'non-http scheme rejected');
});

test('installer: end-to-end with injected runners installs into plugins dir', async () => {
    const ud = tmpUserData();
    const pluginsDir = path.join(ud, 'plugins');
    const inst = new PluginInstaller(pluginsDir, {
        hasGit: true,
        // Fake `git clone`: copy the example plugin into <staging>/repo
        runGit: (args, cwd) => {
            const dest = path.join(cwd, 'repo');
            fs.cpSync(EXAMPLE, dest, { recursive: true });
        },
    });
    const r = await inst.install('https://github.com/example/hello.git', { allowMutable: true });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.id, 'hello');
    assert.strictEqual(r.immutable, false, 'branch HEAD install recorded as mutable');
    assert.ok(fs.existsSync(path.join(pluginsDir, 'hello', 'plugin.json')), 'installed on disk');
});

// ---- netGuard new helper ----------------------------------------------------

test('netGuard.validatePublicFetchTarget: allows public https, blocks metadata/link-local', () => {
    assert.ok(netGuard.validatePublicFetchTarget('https://github.com/x'));
    assert.strictEqual(netGuard.validatePublicFetchTarget('http://169.254.169.254/'), null);
    assert.strictEqual(netGuard.validatePublicFetchTarget('http://metadata.google.internal/'), null);
    assert.strictEqual(netGuard.validatePublicFetchTarget('ftp://github.com/x'), null);
});
