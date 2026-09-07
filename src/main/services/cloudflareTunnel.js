/**
 * Cloudflare quick tunnel (cloudflared) — public URL for phone access.
 *
 * Extracted from main.js (v53.9) so the "wait for the tunnel URL" behavior is
 * unit-testable with a fake cloudflared binary, and so the QR handler can await
 * the URL instead of racing it.
 *
 * Bug this fixes: `cloudflared` needs several seconds after spawn to register
 * its trycloudflare.com hostname (it prints it on stderr). The old code read
 * `remoteUrl` synchronously in the QR IPC, so a user who opened "OPEN ON YOUR
 * PHONE" during that window got a QR encoding the LAN/localhost address —
 * unreachable from their phone. Now callers can `waitForRemoteUrl(timeoutMs)`
 * and only fall back to the LAN URL when the tunnel genuinely isn't up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// cloudflared prints e.g.:
//   INF Registered tunnel connection ... https://see-repeat-reproduced-liable.trycloudflare.com
// The hostname can appear on stderr (normal) — match anywhere in the chunk.
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * @param {object} opts
 * @param {{ getPath: (name: string) => string }} opts.app  Electron app (userData dir).
 * @param {string} [opts.platform]  Injectable for tests.
 * @param {string} [opts.arch]      Injectable for tests.
 */
function createCloudflareTunnel({ app, platform = process.platform, arch = process.arch }) {
    let remoteUrl = null;
    let cfProcess = null;
    // 'idle'     — never started (or start() bailed: disabled / no binary)
    // 'starting' — download/spawn in flight
    // 'running'  — cloudflared process alive
    // 'dead'     — process exited or was stopped
    let state = 'idle';
    const waiters = new Set();

    function notifyWaiters() {
        for (const w of [...waiters]) { try { w(); } catch (_) { /* waiter bug must not kill the tunnel */ } }
    }

    function binaryPath(userData) {
        return path.join(userData, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    }

    function downloadUrlFor() {
        if (platform === 'linux' && arch === 'x64') {
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
        }
        if ((platform === 'win32' || platform === 'darwin') && arch === 'x64') {
            return platform === 'win32'
                ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
                : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64";
        }
        return "";
    }

    /**
     * Download cloudflared if missing, then spawn `cloudflared tunnel --url`.
     * Idempotent: a second call while the process is alive (or starting) is a no-op.
     * Resolves once spawned (or immediately when skipped) — the URL itself
     * arrives asynchronously via waitForRemoteUrl().
     */
    async function start({ port }) {
        if (process.env.AGENT_SMITH_NO_TUNNEL) return; // headless / automated runs opt out
        if (cfProcess || state === 'starting') return;

        state = 'starting';
        const userData = app.getPath('userData');
        const cfPath = binaryPath(userData);
        const downloadUrl = downloadUrlFor();

        if (!fs.existsSync(cfPath) && downloadUrl) {
            console.log('Downloading cloudflared for remote hosting...');
            try {
                if (platform === 'linux') {
                    execSync(`wget -O "${cfPath}" "${downloadUrl}"`);
                    fs.chmodSync(cfPath, 0o755);
                } else if (platform === 'win32') {
                    execSync(`powershell.exe -NoProfile -Command "Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${cfPath.replace(/'/g, "''")}'"`);
                } else {
                    execSync(`curl -L -o "${cfPath}" "${downloadUrl}"`);
                    fs.chmodSync(cfPath, 0o755);
                }
                console.log('cloudflared downloaded successfully.');
            } catch (err) {
                console.error('Failed to download cloudflared:', err && err.message || err);
                state = 'idle'; // no binary → tunnel unavailable; QR falls back to LAN immediately
                return;
            }
        }

        const resolvedBinary = fs.existsSync(cfPath) ? cfPath : null;
        if (!resolvedBinary) { state = 'idle'; return; }

        console.log('Starting Cloudflare Tunnel...');
        const proc = spawn(resolvedBinary, ['tunnel', '--url', `http://localhost:${port}`]);
        cfProcess = proc;
        state = 'running';

        const onOutput = (data) => {
            const match = data.toString().match(TUNNEL_URL_RE);
            if (match && !remoteUrl) {
                remoteUrl = match[0];
                console.log('\n=========================================');
                console.log(' Remote Access URL: ' + remoteUrl);
                console.log('=========================================\n');
                notifyWaiters();
            }
        };
        // cloudflared logs to stderr; watch stdout too so a future log-level
        // change can't silently break URL detection again.
        proc.stderr.on('data', onOutput);
        proc.stdout.on('data', onOutput);

        const onExit = (code) => {
            console.log(`cloudflared process exited with code ${code}`);
            // Only clear state if this is still the current process — a delayed
            // 'close' from an old instance must not clobber a fresh spawn.
            if (cfProcess !== proc) return;
            remoteUrl = null;
            cfProcess = null;
            state = 'dead';
            notifyWaiters();
        };
        proc.on('close', onExit);
        proc.on('error', (err) => {
            console.error('cloudflared failed to start:', err && err.message || err);
            if (cfProcess !== proc) return;
            remoteUrl = null;
            cfProcess = null;
            state = 'dead';
            notifyWaiters();
        });
    }

    /**
     * Resolve with the public tunnel URL, or `null`:
     *  - immediately when already known,
     *  - immediately when no tunnel is possible (never started / disabled /
     *    download failed / process dead) — callers must not hang on those,
     *  - after `timeoutMs` while the tunnel is still coming up.
     */
    function waitForRemoteUrl(timeoutMs = 15000) {
        if (remoteUrl) return Promise.resolve(remoteUrl);
        if (state !== 'starting' && state !== 'running') return Promise.resolve(null);
        const ms = Math.max(0, Number(timeoutMs) || 0);
        return new Promise((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                waiters.delete(settle);
                resolve(remoteUrl || null);
            };
            waiters.add(settle);
            const t = setTimeout(settle, ms);
            if (typeof t.unref === 'function') t.unref(); // never hold the process open
        });
    }

    function stop() {
        if (!cfProcess) return;
        try { cfProcess.kill(); } catch (_) { /* already gone */ }
        remoteUrl = null;
        cfProcess = null;
        state = 'dead';
        notifyWaiters();
    }

    return {
        get remoteUrl() { return remoteUrl; },
        get state() { return state; },
        start,
        waitForRemoteUrl,
        stop
    };
}

module.exports = { createCloudflareTunnel, TUNNEL_URL_RE };
