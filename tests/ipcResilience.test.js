/**
 * IPC registration resilience — a failure while registering ONE domain must not stop the
 * others. This is the regression for "No handler registered for 'auth-register'": startup
 * aborted before the auth handlers were wired, leaving the window up but every channel dead.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const registerAllIpc = require('../src/main/ipc/index.js');

test('a throwing domain does not prevent earlier or later domains from registering', () => {
    const registered = [];
    // Simulate one domain blowing up mid-registration (e.g. it touched a service that
    // failed to init on this machine). 'git-status' lives in the middle of the git domain.
    const ipcMain = {
        handle(name) {
            if (name === 'git-status') throw new Error('simulated domain failure');
            registered.push(name);
        },
        on() {}
    };

    assert.doesNotThrow(() => registerAllIpc(ipcMain, {}), 'registerAllIpc must swallow a domain failure');

    // auth is first and must always register — sign-in/registration can't be collateral damage.
    assert.ok(registered.includes('auth-login'), 'auth-login registered');
    assert.ok(registered.includes('auth-register'), 'auth-register registered (the reported failure)');
    // A domain AFTER the failing one still registers (the loop continued).
    assert.ok(registered.includes('code-run'), 'code domain (after git) still registered');
});
