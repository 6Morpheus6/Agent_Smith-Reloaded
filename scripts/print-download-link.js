#!/usr/bin/env node
/**
 * Print Agent Smith download URLs for a file under project root / Downloads / userData.
 * Usage:
 *   node scripts/print-download-link.js "C:\path\to\file.zip"
 *   AGENT_SMITH_SHARE_PASSWORD=secret node scripts/print-download-link.js "C:\path\to\file.zip" Jerry
 *
 * Requires Agent Smith running (web server on :3000). Starts cloudflared if no tunnel URL
 * is detected within a few seconds.
 */
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const netGuard = require('../src/shared/netGuard.js');

const WEB_PORT = 3000;
const fileArg = process.argv[2];
const username = process.argv[3] || 'Jerry';
const password = process.env.AGENT_SMITH_SHARE_PASSWORD || '';

if (!fileArg) {
    console.error('Usage: node scripts/print-download-link.js "<absolute-path-to-file>" [username]');
    process.exit(1);
}

function validateFile(rawPath) {
    const roots = [];
    const downloads = path.join(os.homedir(), 'Downloads');
    roots.push(downloads);
    try {
        const appData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'agent-smith');
        roots.push(appData);
    } catch (e) { /* ignore */ }
    const cwd = process.cwd();
    roots.push(cwd);
    return netGuard.validateDownloadPath(rawPath, roots);
}

function httpJson(method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: WEB_PORT,
            path: urlPath,
            method,
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Content-Length': payload ? Buffer.byteLength(payload) : 0
            }, headers || {})
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }); }
                catch (e) { resolve({ status: res.statusCode, json: { raw: data } }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login() {
    if (!password) return null;
    const res = await httpJson('POST', '/api/invoke', {
        channel: 'auth-login',
        args: [username, password]
    }, { 'x-auth-action': 'login' });
    if (res.json && res.json.token) return res.json.token;
    throw new Error(res.json.error || `Login failed (HTTP ${res.status})`);
}

async function waitForServer(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try {
            await httpJson('GET', '/');
            return true;
        } catch (e) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return false;
}

function startCloudflared(onUrl) {
    const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'agent-smith');
    const candidates = [
        path.join(userData, 'cloudflared.exe'),
        path.join(userData, 'cloudflared')
    ];
    const bin = candidates.find(p => fs.existsSync(p));
    if (!bin) {
        console.error('cloudflared not found in', userData);
        console.error('Start Agent Smith once to auto-download it, or place cloudflared.exe there.');
        return null;
    }
    const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${WEB_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (chunk) => {
        const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) onUrl(m[0]);
    });
    return proc;
}

async function main() {
    const safe = validateFile(fileArg);
    if (!safe) {
        console.error('File not permitted or missing:', fileArg);
        console.error('Allowed roots: Downloads, Agent Smith userData, current working directory.');
        process.exit(1);
    }

    const up = await waitForServer(5000);
    if (!up) {
        console.error(`Agent Smith web server is not responding on http://127.0.0.1:${WEB_PORT}`);
        console.error('Run npm start first.');
        process.exit(1);
    }

    let remoteUrl = null;
    const cf = startCloudflared((url) => { remoteUrl = url; });

    for (let i = 0; i < 30 && !remoteUrl; i++) {
        await new Promise(r => setTimeout(r, 1000));
    }

    const q = `file=${encodeURIComponent(fileArg)}`;
    const localUrl = `http://127.0.0.1:${WEB_PORT}/download_remote?${q}`;
    let token = null;
    try { token = await login(); } catch (e) {
        if (password) {
            console.error(e.message);
            process.exit(1);
        }
    }
    const tokenSuffix = token ? `&token=${encodeURIComponent(token)}` : '';

    console.log('\n=== Agent Smith download link ===\n');
    console.log('File:', safe);
    console.log('Size:', fs.statSync(safe).size, 'bytes\n');
    console.log('Local (same PC / LAN):');
    console.log(localUrl + tokenSuffix + '\n');

    if (remoteUrl) {
        console.log('Remote (Cloudflare — keep Agent Smith running):');
        console.log(`${remoteUrl}/download_remote?${q}${tokenSuffix}\n`);
    } else {
        console.log('Remote: tunnel URL not ready yet. Check Agent Smith sidebar CONNECT → Web Remote URL,\n' +
            'or re-run this script in ~10 seconds.\n');
    }

    if (!token) {
        console.log('Note: You have user accounts enabled. Recipients must log in at the web UI first,');
        console.log('or re-run with AGENT_SMITH_SHARE_PASSWORD set to append a session token:\n');
        console.log('  $env:AGENT_SMITH_SHARE_PASSWORD="your-password"');
        console.log(`  node scripts/print-download-link.js "${fileArg}" ${username}\n`);
    }

    if (cf) setTimeout(() => { try { cf.kill(); } catch (e) { /* ignore */ } }, 500);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
