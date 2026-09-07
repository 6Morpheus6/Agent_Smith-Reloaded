/**
 * v52 mobile floating composer — the mobile web UI's chat input must stay reachable.
 *
 * The bottom .input-area can be pushed off-screen on phones, so a FAB expands into the
 * REAL #user-input + #send-btn (relocated by src/renderer/ui/mobileComposer.js). This test
 * drives that module in jsdom and asserts: mobile activation relocates the real controls,
 * the FAB toggles open/closed, listeners attached before relocation still fire (app.js's
 * send wiring follows the elements), a wide viewport restores everything — and (v52) the
 * expanded bar can ALWAYS be dismissed via its own ✕ close button: in v51.9 opening hid
 * the FAB, which was the only toggle, so the sheet stayed pinned over the chat forever.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* optional dep */ }

const COMPOSER_HTML = `<!doctype html><body>
  <div class="input-area">
    <div id="attachments-bar"></div>
    <div class="input-controls">
      <button id="attach-btn" type="button">📎</button>
      <textarea id="user-input" placeholder="Enter transmission, Mr. Anderson…"></textarea>
      <button id="send-btn" type="button">SEND</button>
      <button id="stop-btn" type="button" style="display:none;">STOP</button>
    </div>
  </div>
  <div id="mobile-composer" hidden>
    <button type="button" id="mc-fab" class="mc-fab" aria-label="Open chat input">💬</button>
    <div id="mc-bar" class="mc-bar">
      <button type="button" id="mc-close" class="mc-close" aria-label="Close chat input">✕</button>
    </div>
  </div>
</body>`;

// Fresh DOM + controllable matchMedia. `beforeRequire` runs BEFORE the module loads,
// mirroring page load order (defer scripts run in document order: mobileComposer.js
// self-inits on DOMContentLoaded, app.js binds its listeners around the same time).
// jsdom fires DOMContentLoaded asynchronously, so boot() awaits it — init has run by
// the time a test gets the context.
async function boot({ mobile = true, beforeRequire } = {}) {
    const dom = new JSDOM(COMPOSER_HTML);
    global.window = dom.window;
    global.document = dom.window.document;

    let isMobile = mobile;
    const changeListeners = [];
    dom.window.matchMedia = (query) => ({
        get matches() { return query === '(max-width: 768px)' ? isMobile : false; },
        addEventListener: (ev, fn) => { if (ev === 'change') changeListeners.push(fn); },
        removeEventListener: () => {}
    });

    if (beforeRequire) beforeRequire(dom.window.document);

    delete require.cache[require.resolve('../src/renderer/ui/mobileComposer.js')];
    const api = require('../src/renderer/ui/mobileComposer.js'); // attaches window.XKMobileComposer

    if (dom.window.document.readyState === 'loading') {
        await new Promise(r => dom.window.document.addEventListener('DOMContentLoaded', r));
    }

    function setViewport(mobileNow) {
        isMobile = mobileNow;
        for (const fn of changeListeners) fn({ matches: mobileNow });
    }

    return { dom, g: id => dom.window.document.getElementById(id), setViewport };
}

test('mobile: activation relocates the REAL input + send into the floating bar', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: true });
    assert.ok(g('user-input').closest('#mc-bar'), '#user-input moved into #mc-bar');
    assert.ok(g('send-btn').closest('#mc-bar'), '#send-btn moved into #mc-bar');
    assert.ok(!g('mobile-composer').hidden, 'composer container un-hidden on mobile');
    assert.ok(document.body.classList.contains('mobile-composer'));
});

test('FAB click opens the bar (aria + glyph flip), second click closes it', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: true });
    const fab = g('mc-fab');
    const composer = g('mobile-composer');

    fab.click();
    assert.ok(composer.classList.contains('open'), 'bar opens on first tap');
    assert.equal(fab.getAttribute('aria-label'), 'Close chat input');
    assert.notEqual(fab.textContent, '💬', 'glyph flips to a close affordance');

    fab.click();
    assert.ok(!composer.classList.contains('open'), 'bar closes on second tap');
    assert.equal(fab.getAttribute('aria-label'), 'Open chat input');
});

test('listeners attached before relocation still fire (app.js send wiring follows the element)', async () => {
    if (!JSDOM) return;
    let sent = 0;
    const ctx = await boot({
        mobile: true,
        // Simulates app.js's `sendBtn.addEventListener('click', sendMessage)` bound at load —
        // i.e. BEFORE the module relocates the node into #mc-bar.
        beforeRequire: (doc) => doc.getElementById('send-btn').addEventListener('click', () => { sent++; })
    });
    const g = ctx.g;

    assert.ok(g('send-btn').closest('#mc-bar'), 'precondition: send button was relocated');
    g('send-btn').click();
    assert.equal(sent, 1, 'the original click listener survived reparenting and fired');
});

test('wide viewport restores the controls to their original parents', async () => {
    if (!JSDOM) return;
    const { g, setViewport } = await boot({ mobile: true });
    assert.ok(g('user-input').closest('#mc-bar'), 'precondition: relocated on mobile');

    setViewport(false); // rotate / widen to desktop
    assert.ok(!g('user-input').closest('#mc-bar'), '#user-input restored out of the floating bar');
    assert.ok(g('user-input').closest('.input-controls'), '#user-input back in .input-controls');
    assert.ok(g('send-btn').closest('.input-controls'), '#send-btn back in .input-controls');
    assert.ok(!document.body.classList.contains('mobile-composer'));
    assert.ok(g('mobile-composer').hidden, 'composer hidden again on desktop');
});

test('desktop from the start: module is a no-op (nothing relocated)', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: false });
    assert.ok(g('user-input').closest('.input-controls'), 'input stays in place on desktop');
    assert.ok(!document.body.classList.contains('mobile-composer'));
    assert.ok(g('mobile-composer').hidden);
});

// ---- v52: the expanded bar must ALWAYS be dismissable -----------------------
// In v51.9 opening hid the FAB (the only toggle), so once open there was no way to
// close it — the sheet stayed pinned over the chat and the agent's reply could never
// be scrolled back into view. The fix: a dedicated ✕ close button in the bar, with
// open/close state centralized in setOpen() so FAB and close can't disagree.

test('v52: the ✕ close button dismisses an open composer (the v51.9 trap)', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: true });
    const fab = g('mc-fab');
    const closeBtn = g('mc-close');
    const composer = g('mobile-composer');

    assert.ok(closeBtn, 'close button exists in the bar markup');
    assert.ok(!composer.classList.contains('open'), 'starts closed');

    // Open via the FAB (the normal path).
    fab.click();
    assert.ok(composer.classList.contains('open'), 'FAB opens the bar');

    // The v51.9 trap: with the bar open, the FAB is hidden by CSS and was the only
    // toggle — so there was no way out. Now the close button dismisses it.
    closeBtn.click();
    assert.ok(!composer.classList.contains('open'), '✕ closes the bar');
    assert.equal(fab.getAttribute('aria-label'), 'Open chat input', 'FAB aria resets to open state');
    assert.equal(fab.textContent, '\uD83D\uDCAC', 'FAB glyph flips back to 💬');

    // And it can be reopened — the toggle is not one-shot.
    fab.click();
    assert.ok(composer.classList.contains('open'), 'bar reopens after close');
});

test('v52: close button works even when the FAB is unreachable (the exact reported bug)', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: true });
    const composer = g('mobile-composer');
    const closeBtn = g('mc-close');

    // Simulate the user's situation: bar is open and they cannot reach the FAB
    // (it is hidden by CSS while .open). The ONLY way out must be #mc-close.
    window.XKMobileComposer._setOpen(true);
    assert.ok(composer.classList.contains('open'), 'precondition: bar is open');

    closeBtn.click();
    assert.ok(!composer.classList.contains('open'), '✕ dismisses the sheet — chat is visible again');
});

test('v52: closing blurs #user-input so the mobile keyboard goes away with the sheet', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: true });
    const composer = g('mobile-composer');
    const closeBtn = g('mc-close');
    const inp = g('user-input');

    let blurred = 0;
    // jsdom's focus() is a no-op for tracking, so spy on blur directly.
    const origBlur = inp.blur.bind(inp);
    inp.blur = function () { blurred++; return origBlur(); };

    window.XKMobileComposer._setOpen(true);
    assert.ok(composer.classList.contains('open'));

    closeBtn.click();
    // setOpen(false) schedules the blur synchronously (no timer on the close path).
    assert.equal(blurred, 1, 'closing drops focus from the input');
});

test('v52: FAB and close button stay in sync through rapid toggling', async () => {
    if (!JSDOM) return;
    const { g } = await boot({ mobile: true });
    const fab = g('mc-fab');
    const closeBtn = g('mc-close');
    const composer = g('mobile-composer');

    // Interleave both controls — state must never desync (single setOpen source).
    fab.click();      assert.ok(composer.classList.contains('open'));
    closeBtn.click(); assert.ok(!composer.classList.contains('open'));
    fab.click();      assert.ok(composer.classList.contains('open'));
    fab.click();      assert.ok(!composer.classList.contains('open'), 'FAB still toggles after close-button use');
    closeBtn.click(); // no-op when already closed — must not throw or flip state
    assert.ok(!composer.classList.contains('open'), 'close on a closed bar is a safe no-op');
});
