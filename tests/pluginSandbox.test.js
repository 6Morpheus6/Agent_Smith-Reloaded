/**
 * Plugin sandbox: verifies the OS-enforced isolation properties directly (plain Node,
 * not Electron). A sandboxed tool returns its value, but cannot spawn a child process
 * (denied by the permission model) and cannot escape the project root via host.fs.
 * Async capabilities are brokered to the parent. Skips if the runtime lacks --permission.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runToolSandboxed, permissionSupported } = require('../src/main/services/pluginSandbox.js');

const SUPPORTED = permissionSupported();
const opt = SUPPORTED ? {} : { skip: 'Node Permission Model not available' };

function pluginWith(code) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-sbx-'));
    fs.writeFileSync(path.join(dir, 'tool.js'), code);
    return { dir, toolFile: path.join(dir, 'tool.js') };
}

test('sandboxed tool returns its value', opt, async () => {
    const { dir, toolFile } = pluginWith(
        'module.exports = { async run(args){ return "echo:" + (args.text||""); } };'
    );
    const r = await runToolSandboxed({ pluginDir: dir, toolFile, args: { text: 'hi' }, grantedCaps: [] });
    assert.equal(r, 'echo:hi');
});

test('sandboxed tool CANNOT spawn a child process (permission denied)', opt, async () => {
    const { dir, toolFile } = pluginWith(
        'module.exports = { async run(){ require("child_process").execSync("echo pwned"); return "ran"; } };'
    );
    const r = await runToolSandboxed({ pluginDir: dir, toolFile, args: {}, grantedCaps: [] });
    assert.match(r, /^Error:/, 'spawning must fail');
    assert.ok(!/ran/.test(r), 'tool must not have completed the spawn');
});

test('sandboxed host.fs is contained to the project root', opt, async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-sbx-proj-'));
    const { dir, toolFile } = pluginWith(
        'module.exports = { async run(_a, host){ host.fs.writeFile("note.txt","ok"); return host.fs.readFile("note.txt"); } };'
    );
    const r = await runToolSandboxed({ pluginDir: dir, toolFile, args: {}, grantedCaps: ['fs'], projectRoot });
    assert.equal(r, 'ok');
    assert.ok(fs.existsSync(path.join(projectRoot, 'note.txt')));

    const esc = pluginWith(
        'module.exports = { async run(_a, host){ return host.fs.readFile("../../../../etc/passwd"); } };'
    );
    const r2 = await runToolSandboxed({ pluginDir: esc.dir, toolFile: esc.toolFile, args: {}, grantedCaps: ['fs'], projectRoot });
    assert.match(r2, /^Error:/);
    assert.match(r2, /escapes project root/);
});

test('async shell capability is brokered to the parent', opt, async () => {
    const { dir, toolFile } = pluginWith(
        'module.exports = { async run(_a, host){ const r = await host.shell.run("anything"); return "got:" + r.stdout; } };'
    );
    const broker = async (cap, method, args) => {
        assert.equal(cap, 'shell');
        return { stdout: 'brokered(' + args[0] + ')' };
    };
    const r = await runToolSandboxed({ pluginDir: dir, toolFile, args: {}, grantedCaps: ['shell'], broker });
    assert.equal(r, 'got:brokered(anything)');
});

test('PluginManager opt-in sandbox runs a real plugin tool end-to-end', opt, async () => {
    const PluginManager = require('../src/main/services/pluginManager.js');
    const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-sbx-pm-'));
    fs.mkdirSync(path.join(ud, 'plugins'), { recursive: true });
    fs.cpSync(EXAMPLE, path.join(ud, 'plugins', 'hello'), { recursive: true });

    const pm = new PluginManager(ud, { sandbox: true });
    pm.discover();
    pm.setEnabled('hello', true, ['log']);
    const out = await pm.invokeTool('hello_echo', { text: 'sandbox' });
    assert.equal(out, 'hello: sandbox', 'tool ran inside the sandbox and returned its value');
});
