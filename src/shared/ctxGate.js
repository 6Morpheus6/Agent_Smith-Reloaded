/**
 * v51.5 — app-wide context-window policy shared by the renderer (gate + reflection) and
 * testable without a browser or Electron.
 *
 * Two rules, both about HONESTY with the model that is actually loaded in LM Studio:
 *
 * 1. MINIMUM CTX GATE — Agent Smith needs at least 64K of context for any model it uses.
 *    Below that window multi-turn agent work (and every Code Mode build) loses the plot.
 *    The gate only fires when the local server can VERIFY the loaded size; an unmanaged or
 *    unreachable endpoint cannot be judged, so chat stays usable there.
 *
 * 2. REFLECTION — the context slider must MIRROR what LM Studio actually has loaded for the
 *    selected model (the user's own setting in LM Studio wins over computed defaults).
 */
'use strict';

const DEFAULT_MIN_CTX = 64000;
// Slider bounds kept in one place so reflection never writes values the UI cannot display.
const CTX_SLIDER_MIN = 2048;
const CTX_SLIDER_MAX = 262144;

/** Current minimum ctx for any model used by Agent Smith (env-overridable for tests/hardware). */
function minCtx() {
    // `process` only exists in Node — the Electron renderer runs with nodeIntegration:false,
    // so a bare reference here threw "ReferenceError: process is not defined" on EVERY send
    // (uncaught above sendMessage's try/catch → input never cleared, nothing rendered).
    const n = Number((typeof process !== 'undefined' && process.env) ? process.env.XK_MIN_CTX : NaN);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MIN_CTX;
}

/**
 * @param {object|null} status result of the 'lmstudio-get-status' IPC:
 *   { managed: true, loadedContext, maxContext } when the local server manages this model,
 *   or { managed: false, reason } otherwise.
 * @returns {{ ok: boolean, verified: boolean, loadedContext?: number|null, minCtx?: number, message?: string }}
 */
function checkCtxGate(status) {
    const min = minCtx();
    const loaded = Number(status?.managed === true ? status.loadedContext : NaN);
    if (!Number.isFinite(loaded) || loaded <= 0) {
        // Cannot verify (remote endpoint, LM Studio down, model not found): do NOT block.
        return { ok: true, verified: false, loadedContext: null };
    }
    if (loaded >= min) {
        return { ok: true, verified: true, loadedContext: loaded, minCtx: min };
    }
    return {
        ok: false,
        verified: true,
        loadedContext: loaded,
        minCtx: min,
        message: `Model "${status.model || 'the selected model'}" is loaded with ${loaded} tokens of context — Agent Smith requires at least ${min}. In LM Studio, unload it and reload it with a context length of ${min} or higher (Context Length in the model's load settings), then reselect the model here.`
    };
}

/**
 * Reflect the REAL loaded context over a computed/desired value. When the local server
 * manages this model and has it loaded, its actual window wins; otherwise fall back to the
 * desired value unchanged. Result is clamped into the slider's displayable range.
 */
function reflectLoadedContext(desiredNumCtx, status) {
    const loaded = Number(status?.managed === true ? status.loadedContext : NaN);
    if (!Number.isFinite(loaded) || loaded <= 0) return desiredNumCtx;
    return Math.min(Math.max(loaded, CTX_SLIDER_MIN), CTX_SLIDER_MAX);
}

const api = { minCtx, checkCtxGate, reflectLoadedContext, DEFAULT_MIN_CTX, CTX_SLIDER_MIN, CTX_SLIDER_MAX };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKCtxGate = api;
