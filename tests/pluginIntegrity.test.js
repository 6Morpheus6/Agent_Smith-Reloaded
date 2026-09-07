/**
 * Plugin integrity / trust-on-enable: a plugin's approved bytes are hashed when enabled,
 * and a later change quarantines it (without executing the changed code) until re-enabled.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PluginManager = require('../src/main/services/pluginManager.js');
const { hashPluginDir } = require('../src/main/services/pluginIntegrity.js');

const EXAMPLE = path.join(__dirname, '..', 'src', 'examples', 'plugins', 'hello');

function setup() {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-pi-'));
    const pluginsDir = path.join(ud, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(EXAMPLE, path.join(pluginsDir, 'hello'), { recursive: true });
    return { ud, pluginsDir };
}

test('hashPluginDir is deterministic and changes when content changes', () => {
    const { pluginsDir } = setup();
    const dir = path.join(pluginsDir, 'hello');
    const h1 = hashPluginDir(dir);
    const h2 = hashPluginDir(dir);
    assert.equal(h1, h2);
    fs.appendFileSync(path.join(dir, 'tools', 'echo.js'), '\n// tampered\n');
    assert.notEqual(hashPluginDir(dir), h1);
});

test('enabling records trust; unchanged plugin stays trusted across rediscover', () => {
    const { ud } = setup();
    let pm = new PluginManager(ud, {});
    pm.discover();
    pm.setEnabled('hello', true, ['log']);
    assert.equal(pm.list()[0].integrity, 'trusted');

    const pm2 = new PluginManager(ud, {});
    pm2.discover();
    const h = pm2.list()[0];
    assert.equal(h.enabled, true);
    assert.equal(h.integrity, 'trusted');
    assert.equal(pm2.getEnabledToolSchemas().length, 1, 'trusted plugin still exposes its tool');
});

test('tampering after trust quarantines the plugin and does not run its tools', () => {
    const { ud, pluginsDir } = setup();
    let pm = new PluginManager(ud, {});
    pm.discover();
    pm.setEnabled('hello', true, ['log']);

    // tamper with the trusted plugin on disk
    fs.appendFileSync(path.join(pluginsDir, 'hello', 'tools', 'echo.js'), '\n// injected\n');

    const pm2 = new PluginManager(ud, {});
    pm2.discover();
    const h = pm2.list().find(p => p.id === 'hello');
    assert.equal(h.enabled, false, 'tampered plugin disabled');
    assert.equal(h.integrity, 'changed');
    assert.ok(/content changed/.test(h.error), 'quarantine reason surfaced');
    assert.equal(pm2.getEnabledToolSchemas().length, 0, 'tampered tools not exposed');
});

test('re-enabling a tampered plugin re-trusts the new bytes and reloads its tools', () => {
    const { ud, pluginsDir } = setup();
    let pm = new PluginManager(ud, {});
    pm.discover();
    pm.setEnabled('hello', true, ['log']);
    fs.appendFileSync(path.join(pluginsDir, 'hello', 'tools', 'echo.js'), '\n// injected\n');

    const pm2 = new PluginManager(ud, {});
    pm2.discover();
    assert.equal(pm2.list()[0].integrity, 'changed');
    pm2.setEnabled('hello', true, ['log']); // user re-trusts
    const h = pm2.list().find(p => p.id === 'hello');
    assert.equal(h.integrity, 'trusted');
    assert.equal(h.enabled, true);
    assert.equal(pm2.getEnabledToolSchemas().length, 1, 'tool reloaded after re-trust');
});
