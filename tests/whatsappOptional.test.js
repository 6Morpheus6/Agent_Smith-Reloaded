/**
 * WhatsApp is an OPTIONAL feature (its deps pull puppeteer/Chromium, which is why a lean
 * install omits them). Registering its IPC must never throw at load/registration time, and
 * the channels must still register so the renderer's invokes resolve — only USING WhatsApp
 * without the optional deps should return a friendly error. This locks the "lean install
 * still boots" guarantee the README leans on.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const registerWhatsAppIpc = require('../src/main/lifecycle/whatsapp.js');

test('registerWhatsAppIpc registers channels without throwing (deps present or not)', () => {
    const handlers = new Map();
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
    assert.doesNotThrow(() => registerWhatsAppIpc(ipcMain, () => null, { getPath: () => '.' }, () => {}));
    assert.ok(handlers.has('whatsapp-init'), 'whatsapp-init registered');
    assert.ok(handlers.has('whatsapp-send'), 'whatsapp-send registered');
});

test('whatsapp-send before init returns an error instead of throwing', async () => {
    const handlers = new Map();
    registerWhatsAppIpc({ handle: (n, fn) => handlers.set(n, fn) }, () => null, { getPath: () => '.' }, () => {});
    const res = await handlers.get('whatsapp-send')({}, { number: '1', message: 'hi' });
    assert.ok(res && res.error, 'returns a structured error, not a throw');
});
