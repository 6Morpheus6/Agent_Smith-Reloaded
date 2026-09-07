'use strict';

// Shared session handling for HIDDEN BrowserWindows (runtime verification, browser verify, web
// capture). The main window registers a strict Content-Security-Policy header injection on
// session.defaultSession (main.js) to lock down the LLM/markdown renderer. Hidden windows that load
// user-built pages or arbitrary URLs must NOT inherit that policy: it turns perfectly valid external
// resources (Google Fonts stylesheets, CDN scripts/fonts) into phantom console errors and makes a
// complete, working app fail its OWN harness check — "built but blocked", where the run never reaches
// "done" because the gate reports [RUNTIME] CSP violations that only exist inside our verification
// window.
//
// This helper returns webPreferences for such windows (a dedicated in-memory partition, isolated from
// defaultSession) plus a post-create hook that strips any Content-Security-Policy header on that
// session as belt-and-suspenders. The partition is in-memory (no `persist:` prefix): it never touches
// the user's real browser profile and carries no app cookies/storage into captured pages.

const VERIFY_PARTITION = 'xk-hidden-window'; // in-memory; distinct from defaultSession

/** webPreferences for a hidden verification/capture window. */
function hiddenWindowWebPreferences(extra = {}) {
    return Object.assign({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: VERIFY_PARTITION
    }, extra);
}

// Strip Content-Security-Policy from responses on the window's session so external styles/fonts/CDNs
// load as-is. Registered at most once per session instance (Electron keeps one handler; a Set keyed by
// the session object guarantees no stacking even if called repeatedly for reused in-memory sessions).
const _cspStripped = new Set();

function stripCspOnSession(win) {
    try {
        const ses = win.webContents.session;
        if (_cspStripped.has(ses)) return;
        _cspStripped.add(ses);
        ses.webRequest.onHeadersReceived((details, callback) => {
            const headers = Object.assign({}, details.responseHeaders || {});
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === 'content-security-policy') delete headers[k];
            }
            callback({ responseHeaders: headers });
        });
    } catch (e) { /* non-fatal — verification must never break the run */ }
}

module.exports = { VERIFY_PARTITION, hiddenWindowWebPreferences, stripCspOnSession };
