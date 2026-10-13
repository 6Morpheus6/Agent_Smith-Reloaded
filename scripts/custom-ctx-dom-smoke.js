#!/usr/bin/env node
/**
 * v56.0.1 packaged-app smoke — boots the BUILT linux-unpacked binary headless with CDP and
 * asserts the new typed custom-context field is present in the real DOM next to Auto-tune:
 *   - #custom-ctx-input (text input) + #custom-ctx-apply-btn (APPLY button) exist
 *   - they sit inside the TUNING section, right after #auto-tune-toggle / #runtime-profile-chip
 *   - window.XKRuntimeProfileUI.applyCtx is wired (the function both APPLY buttons call)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'release', 'linux-unpacked', 'agent-smith');
const PORT = 9371; // unique — avoid clashing with other e2e scripts (9356 etc.)
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmith-v5601-smoke-'));

function httpJson(p) {
    return new Promise((resolve, reject) => {
        const req = require('http').get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve(JSON.parse(b)));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('timeout ' + p)));
    });
}

async function waitForCDP(deadlineMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        try { return await httpJson('/json/list'); } catch (e) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('CDP endpoint never came up on :' + PORT);
}

function cdpEval(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('CDP eval timeout')); }, 15000);
        ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })));
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id === 1) {
                clearTimeout(timer);
                try { ws.close(); } catch (e) {}
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result?.result?.value);
            }
        });
        ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

(async () => {
    const child = spawn(BIN, [
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${USER_DATA}`
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));

    try {
        const targets = await waitForCDP(60000);
        const page = targets.find((t) => t.type === 'page');
        if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map((t) => t.url)));

        // Give the renderer a moment to finish mounting (app.js runs on DOMContentLoaded).
        await new Promise((r) => setTimeout(r, 4000));

        const dom = await cdpEval(page.webSocketDebuggerUrl, `(() => {
            const input = document.getElementById('custom-ctx-input');
            const btn = document.getElementById('custom-ctx-apply-btn');
            const toggle = document.getElementById('auto-tune-toggle');
            const chip = document.getElementById('runtime-profile-chip');
            return {
                hasInput: !!input,
                inputType: input ? input.type : null,
                hasApplyBtn: !!btn,
                btnLabel: btn ? btn.textContent.trim() : null,
                hasAutoTuneToggle: !!toggle,
                hasChip: !!chip,
                // The field must live in the TUNING section (same body as the toggle).
                sameSection: !!(input && toggle && input.closest('[data-section="tuning"]') === toggle.closest('[data-section="tuning"]')),
                applyCtxWired: typeof window.XKRuntimeProfileUI?.applyCtx === 'function',
                versionBadge: document.getElementById('app-version')?.textContent || null
            };
        })()`);

        console.log(JSON.stringify(dom, null, 2));
        const ok = dom.hasInput && dom.inputType === 'text' && dom.hasApplyBtn && dom.btnLabel === 'APPLY'
            && dom.hasAutoTuneToggle && dom.sameSection && dom.applyCtxWired;
        if (!ok) throw new Error('DOM contract failed: ' + JSON.stringify(dom));
        console.log(`PASS — packaged app v${dom.versionBadge} renders the typed custom-context field in TUNING, applyCtx wired.`);
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 1500));
        try { child.kill('SIGKILL'); } catch (e) {}
        fs.rmSync(USER_DATA, { recursive: true, force: true });
    }
})().catch((e) => { console.error('FAIL —', e.message); process.exit(1); });
