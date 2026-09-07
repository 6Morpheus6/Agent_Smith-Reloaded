/**
 * sendSlot — the single in-flight run slot for Chat/Agent sends.
 *
 * v53.1 (mobile "task loops after completion" fix): sendMessage() used to check its busy
 * guard, then AWAIT pre-flight work (plugin expansion / context sync / model swap), and only
 * set isSending=true afterwards. Two taps ~50ms apart — routine on touch — both passed the
 * guard and started the SAME task twice. The fix: claim the slot SYNCHRONOUSLY before any
 * await, so a second send in that window is refused; release it on every early return and
 * when the run ends (finally).
 *
 * Extracted as a pure module (DI-testable) instead of inline state in app.js — the same
 * pattern as runState.js. `states` are the live XKRunState objects, so chatRunState.isBusy
 * keeps its existing meaning for mode-switch blocking and the stop button.
 */
'use strict';

function createSendSlot(states = {}) {
    const chatRunState = states.chatRunState || { isBusy: false };
    let claimed = false;

    function isBusy() {
        return claimed || !!chatRunState.isBusy || !!(states.codeRunState && states.codeRunState.isBusy);
    }

    /** Synchronous claim — the whole point. Returns false (and changes nothing) when busy. */
    function claim() {
        if (isBusy()) return false;
        claimed = true;
        chatRunState.isBusy = true; // block mode switches mid-run, as before
        return true;
    }

    /** Release the slot — call on every early return and in the run's finally. */
    function release() {
        claimed = false;
        chatRunState.isBusy = false;
    }

    return { isBusy, claim, release };
}

const api = { createSendSlot };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKSendSlot = api;
