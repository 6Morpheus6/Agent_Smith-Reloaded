/**
 * Cloudflare tunnel service — v53.9 QR fix regression tests.
 *
 * The bug: `cloudflared` takes seconds to register its trycloudflare.com
 * hostname (printed on stderr). The old main.js read `remoteUrl` synchronously
 * in the get-remote-qr IPC, so opening "OPEN ON YOUR PHONE" during that window
 * produced a QR encoding the LAN/localhost URL — unreachable from a phone.
 *
 * These tests drive createCloudflareTunnel() with FAKE cloudflared binaries
 * (shell scripts) that mimic the real binary's behavior: delayed stderr output,
 * box-drawn banner format, staying alive until killed. No network involved.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCloudflareTunnel, TUNNEL_URL_RE } = require('../src/main/services/cloudflareTunnel.js');

// Build a fake cloudflared at <userData>/cloudflared (exactly where the service
// looks) that prints the real banner shape on stderr after `urlDelayMs`.
function makeFakeUserData({ urlDelayMs = 400, url = 'https://see-repeat-reproduced-liable.trycloudflare.com', stayAliveSec = 30 } = {}) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-cf-fake-'));
    const lines = [
        '#!/bin/sh',
        `sleep ${urlDelayMs / 1000}`,
        'echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
        'echo "+--------------------------------------------------------------------------------------------+" >&2',
        'echo "|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |" >&2',
        `echo "|  ${url}                                    |" >&2`,
        'echo "+--------------------------------------------------------------------------------------------+" >&2',
        `sleep ${stayAliveSec}`
    ];
    fs.writeFileSync(path.join(userData, 'cloudflared'), lines.join('\n') + '\n');
    fs.chmodSync(path.join(userData, 'cloudflared'), 0o755); // spawn() needs the exec bit
    return userData;
}

function makeFakeUserDataThatDiesImmediately() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-cf-fake-'));
    fs.writeFileSync(path.join(userData, 'cloudflared'), '#!/bin/sh\necho "INF Requesting new quick Tunnel..." >&2\nexit 1\n');
    fs.chmodSync(path.join(userData, 'cloudflared'), 0o755); // spawn() needs the exec bit
    return userData;
}

function fakeApp(userDataDir) {
    return { getPath: (name) => { assert.equal(name, 'userData'); return userDataDir; } };
}

const OPTS = { platform: 'linux', arch: 'x64' };

test('waitForRemoteUrl resolves with the trycloudflare URL after cloudflared registers it (the QR race)', async () => {
    const app = fakeApp(makeFakeUserData({ urlDelayMs: 400 }));
    const tunnel = createCloudflareTunnel({ app, ...OPTS });
    await tunnel.start({ port: 3000 });

    // The regression: a caller that arrives BEFORE the URL is printed must still
    // get the public URL — not null (which would mean "encode LAN instead").
    const t0 = Date.now();
    const url = await tunnel.waitForRemoteUrl(5000);
    assert.match(url, TUNNEL_URL_RE, 'waiter got a trycloudflare.com URL');
    assert.ok(Date.now() - t0 < 4000, 'resolved well inside the timeout (URL arrives ~0.4s)');
    assert.equal(tunnel.remoteUrl, url);

    tunnel.stop();
});

test('waitForRemoteUrl resolves immediately when the URL is already known', async () => {
    const app = fakeApp(makeFakeUserData({ urlDelayMs: 1 }));
    const tunnel = createCloudflareTunnel({ app, ...OPTS });
    await tunnel.start({ port: 3000 });

    const url = await tunnel.waitForRemoteUrl(5000);
    assert.ok(url && TUNNEL_URL_RE.test(url));

    // Second wait is instant (no re-waiting).
    const t0 = Date.now();
    const again = await tunnel.waitForRemoteUrl(5000);
    assert.equal(again, url);
    assert.ok(Date.now() - t0 < 100, 'already-known URL resolves immediately');

    tunnel.stop();
});

test('waitForRemoteUrl resolves null IMMEDIATELY when no tunnel was ever started (no 15 s hang)', async () => {
    const app = fakeApp(fs.mkdtempSync(path.join(os.tmpdir(), 'xk-cf-fake-')));
    const tunnel = createCloudflareTunnel({ app, ...OPTS });

    const t0 = Date.now();
    const url = await tunnel.waitForRemoteUrl(15000); // same call the QR handler makes
    assert.equal(url, null);
    assert.ok(Date.now() - t0 < 200, 'idle state must not block the QR modal');
});

test('AGENT_SMITH_NO_TUNNEL=1 → start() is a no-op and waits resolve null immediately', async () => {
    const app = fakeApp(fs.mkdtempSync(path.join(os.tmpdir(), 'xk-cf-fake-')));
    process.env.AGENT_SMITH_NO_TUNNEL = '1';
    try {
        const tunnel = createCloudflareTunnel({ app, ...OPTS });
        await tunnel.start({ port: 3000 });
        assert.equal(tunnel.state, 'idle');
        const t0 = Date.now();
        assert.equal(await tunnel.waitForRemoteUrl(15000), null);
        assert.ok(Date.now() - t0 < 200);
    } finally {
        delete process.env.AGENT_SMITH_NO_TUNNEL;
    }
});

test('cloudflared dies before printing a URL → waiter resolves null promptly (falls back to LAN)', async () => {
    const app = fakeApp(makeFakeUserDataThatDiesImmediately());
    const tunnel = createCloudflareTunnel({ app, ...OPTS });
    await tunnel.start({ port: 3000 });
    // Give the process a moment to exit.
    await new Promise((r) => setTimeout(r, 150));

    const t0 = Date.now();
    const url = await tunnel.waitForRemoteUrl(5000);
    assert.equal(url, null);
    assert.ok(Date.now() - t0 < 2000, 'dead process must not make the caller wait out the timeout');
});

test('stop() clears the URL and subsequent waits resolve null immediately', async () => {
    const app = fakeApp(makeFakeUserData({ urlDelayMs: 1 }));
    const tunnel = createCloudflareTunnel({ app, ...OPTS });

    await tunnel.start({ port: 3000 });
    const url = await tunnel.waitForRemoteUrl(5000);
    assert.ok(url && TUNNEL_URL_RE.test(url));

    tunnel.stop();
    assert.equal(tunnel.remoteUrl, null);
    const t0 = Date.now();
    assert.equal(await tunnel.waitForRemoteUrl(5000), null);
    assert.ok(Date.now() - t0 < 200);
});

test('TUNNEL_URL_RE matches the real cloudflared box-drawn banner line', () => {
    const realLine = 'INF |  https://see-repeat-reproduced-liable.trycloudflare.com                                    |';
    assert.ok(TUNNEL_URL_RE.test(realLine));
    // And does NOT match a LAN/localhost address (the thing the QR must not encode).
    assert.equal(TUNNEL_URL_RE.test('http://192.168.1.42:3000'), false);
});

test('start() is idempotent — second call while running does not respawn', async () => {
    const app = fakeApp(makeFakeUserData({ urlDelayMs: 1 }));
    const tunnel = createCloudflareTunnel({ app, ...OPTS });

    await tunnel.start({ port: 3000 });
    await tunnel.waitForRemoteUrl(5000);
    await tunnel.start({ port: 3000 }); // must be a no-op
    assert.equal(tunnel.state, 'running');

    tunnel.stop();
});
