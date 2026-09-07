/**
 * WhatsApp QR linking needs a Chrome/Chromium binary. resolveChromeExecutable should
 * fall back to a system browser when Puppeteer's cache is empty.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Module = require('module');

const realLoad = Module._load;

test('resolveChromeExecutable falls back to system Chrome when puppeteer cache is empty', () => {
    // Simulate an EMPTY puppeteer cache for the duration of the call. The mock must stay
    // active while resolveChromeExecutable() runs — not only while requiring whatsapp.js —
    // otherwise, on a machine where puppeteer DID download Chrome, the real
    // executablePath() resolves to that cache and the fallback branch is never tested.
    Module._load = function (request) {
        if (request === 'puppeteer') throw new Error('Could not find Chrome (cache empty).');
        return realLoad.apply(this, arguments);
    };
    // These env vars are higher-priority candidates than /usr/bin/* in the resolver, so
    // neutralize them to keep the assertion deterministic; restored in finally.
    const savedEnv = {
        puppeteer: process.env.PUPPETEER_EXECUTABLE_PATH,
        chrome: process.env.CHROME_PATH
    };
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    delete process.env.CHROME_PATH;
    delete require.cache[require.resolve('../src/main/lifecycle/whatsapp.js')];

    try {
        const { resolveChromeExecutable } = require('../src/main/lifecycle/whatsapp.js');
        // Same system candidates the resolver scans (sans the env vars above).
        const candidates = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        ];
        const found = candidates.find((p) => fs.existsSync(p)) || null;
        assert.equal(resolveChromeExecutable(), found);
    } finally {
        Module._load = realLoad;
        if (savedEnv.puppeteer === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
        else process.env.PUPPETEER_EXECUTABLE_PATH = savedEnv.puppeteer;
        if (savedEnv.chrome === undefined) delete process.env.CHROME_PATH;
        else process.env.CHROME_PATH = savedEnv.chrome;
    }
});
