/**
 * Plugin sandbox runner (child process). Runs exactly ONE plugin tool under Node's
 * Permission Model. child_process / worker_threads are denied by the parent's
 * --permission flags, and fs is scoped to the project root, so even a hostile plugin
 * cannot spawn processes or read/write outside the project. Capabilities that reach the
 * outside world (shell, net, memory) are brokered back to the parent over IPC, where the
 * existing command/net guards apply.
 *
 * This file must stay dependency-free (only node builtins + the tool file) so it loads
 * cleanly under a tight --allow-fs-read grant.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const pending = new Map();
let nextId = 1;

function broker(cap, method, args) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        process.send({ type: 'cap', id, cap, method, args });
    });
}

function buildHost(caps, projectRoot) {
    const has = (c) => Array.isArray(caps) && caps.includes(c);
    const host = { log: (m) => process.send({ type: 'log', msg: String(m) }) };

    if (has('fs') && projectRoot) {
        const fs = require('fs');
        const contain = (p) => {
            const abs = path.resolve(projectRoot, String(p));
            const rel = path.relative(projectRoot, abs);
            if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path escapes project root');
            return abs;
        };
        host.fs = {
            readFile: (p) => fs.readFileSync(contain(p), 'utf8'),
            writeFile: (p, c) => { fs.writeFileSync(contain(p), c); return contain(p); },
            exists: (p) => { try { return fs.existsSync(contain(p)); } catch (e) { return false; } },
            list: (p) => fs.readdirSync(contain(p)),
        };
    }
    if (has('shell')) host.shell = { run: (cmd) => broker('shell', 'run', [cmd]) };
    if (has('net')) host.net = { fetch: (url, opts) => broker('net', 'fetch', [url, opts]) };
    if (has('memory')) {
        host.memory = {
            store: (t, m) => broker('memory', 'store', [t, m]),
            query: (t, k) => broker('memory', 'query', [t, k]),
        };
    }
    return host;
}

process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'cap-result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        return msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error || 'capability error'));
    }
    if (msg.type !== 'invoke') return;
    try {
        // In-child containment check: the parent sends toolFile discovered by
        // pluginManager (already scoped to the plugin dir), but the runner protocol
        // itself only sends toolFile. A future caller could pass a file outside the
        // plugin dir while also granting project-root fs permissions — re-check here
        // before require() so the child never loads code from outside the plugin dir.
        const pluginDir = msg.pluginDir;
        const toolFile = msg.toolFile;
        if (!pluginDir || !toolFile) throw new Error('sandbox invoke missing pluginDir or toolFile');
        fs.lstatSync(pluginDir);
        fs.lstatSync(toolFile);
        const realPluginDir = fs.realpathSync(pluginDir);
        const realToolFile = fs.realpathSync(toolFile);
        const rel = path.relative(realPluginDir, realToolFile);
        const relParts = rel.split(path.sep);
        if (rel === '..' || rel.startsWith('..') || relParts.includes('..') || path.isAbsolute(rel)) {
            throw new Error(`tool file "${toolFile}" escapes plugin dir "${pluginDir}" — refusing to require`);
        }
        const host = buildHost(msg.grantedCaps, msg.projectRoot);
        const mod = require(realToolFile);
        if (!mod || typeof mod.run !== 'function') throw new Error('tool module missing run()');
        const out = await mod.run(msg.args || {}, host);
        const value = out == null ? 'Success' : (typeof out === 'string' ? out : JSON.stringify(out));
        process.send({ type: 'result', value });
    } catch (e) {
        process.send({ type: 'error', message: (e && e.message) ? e.message : String(e) });
    } finally {
        setTimeout(() => process.exit(0), 5);
    }
});
