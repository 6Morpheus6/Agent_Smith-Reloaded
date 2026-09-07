/**
 * Plugin sandbox (parent side). Runs a plugin tool in a forked child process under
 * Node's Permission Model: child_process and worker_threads are denied, and fs is
 * granted only for the plugin dir (read) and project root (read/write) — OS-enforced,
 * not just facade-enforced. Async capabilities (shell/net/memory) are brokered back here.
 *
 * Opt-in: pluginManager enables this only when constructed with { sandbox:true } or with
 * AGENT_SMITH_PLUGIN_SANDBOX=1. The default (in-process) path is unchanged. Electron's
 * ELECTRON_RUN_AS_NODE fork honoring --permission is environment-dependent; on any infra
 * failure the caller falls back to the in-process path so functionality is preserved.
 */
'use strict';

const cp = require('child_process');
const path = require('path');

const RUNNER = path.join(__dirname, 'pluginSandboxRunner.js');

/** Node Permission Model is stable from v20+. */
function permissionSupported() {
    if (process.permission) return true;
    const m = /^v(\d+)\./.exec(process.version || '');
    return m ? parseInt(m[1], 10) >= 20 : false;
}

/**
 * @param {object} opts
 *   pluginDir, toolFile, args, grantedCaps[], projectRoot, broker(cap,method,args)->Promise,
 *   timeoutMs, forkImpl (test inject)
 * @returns {Promise<string>} the tool's string result, or an "Error: ..." string.
 */
function runToolSandboxed(opts) {
    const {
        pluginDir, toolFile, args, grantedCaps = [], projectRoot,
        broker, timeoutMs = 15000, forkImpl
    } = opts;
    const fork = forkImpl || cp.fork;

    const execArgv = ['--permission', `--allow-fs-read=${pluginDir}`, `--allow-fs-read=${__dirname}`];
    if (grantedCaps.includes('fs') && projectRoot) {
        execArgv.push(`--allow-fs-read=${projectRoot}`, `--allow-fs-write=${projectRoot}`);
    }

    return new Promise((resolve) => {
        let done = false;
        let child;
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { if (child) child.kill(); } catch (e) { /* ignore */ }
            resolve(r);
        };
        const timer = setTimeout(() => finish(`Error: plugin tool timed out after ${timeoutMs}ms (sandbox killed)`), timeoutMs);

        try {
            child = fork(RUNNER, [], { execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        } catch (e) {
            return finish(`Error: sandbox fork failed: ${e.message}`);
        }

        child.on('message', async (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'result') return finish(msg.value);
            if (msg.type === 'error') return finish(`Error: ${msg.message}`);
            if (msg.type === 'log') return; // could forward to a logger
            if (msg.type === 'cap') {
                let ok = true, value = null, error = null;
                try {
                    value = broker ? await broker(msg.cap, msg.method, msg.args) : null;
                    if (broker == null) { ok = false; error = 'capability broker unavailable'; }
                } catch (e) { ok = false; error = e.message; }
                try { child.send({ type: 'cap-result', id: msg.id, ok, value, error }); } catch (e) { /* child gone */ }
            }
        });
        child.on('error', (e) => finish(`Error: sandbox error: ${e.message}`));
        child.on('exit', (code) => { if (!done) finish(`Error: sandbox exited (code ${code}) before returning a result`); });

        try {
            child.send({ type: 'invoke', pluginDir, toolFile, args, grantedCaps, projectRoot });
        } catch (e) {
            finish(`Error: could not start sandboxed tool: ${e.message}`);
        }
    });
}

module.exports = { runToolSandboxed, permissionSupported, RUNNER };
