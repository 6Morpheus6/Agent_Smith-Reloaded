/**
 * Coalescing render throttle (renderer).
 *
 * The agent loop calls onDelta(fullContent) on EVERY streamed token. Re-rendering
 * the whole growing buffer (markdown parse + syntax highlight + innerHTML reflow)
 * per token is O(n^2) and saturates the UI thread — the window freezes, worst with
 * small models that stream tool calls as plain text. This throttle bounds rendering
 * to at most one call per `intervalMs`, always rendering the LATEST value, with a
 * trailing flush so the final state still paints. The UI thread gets breathing room
 * between renders, so clicks/scroll/animation stay responsive.
 *
 * Exposed as `window.createThrottledRenderer` and as a CommonJS export for tests.
 */
(function (global) {
    function now() {
        return (typeof Date !== 'undefined' && Date.now) ? Date.now() : new Date().getTime();
    }

    function createThrottledRenderer(renderFn, intervalMs) {
        intervalMs = intervalMs || 100;
        let pending = null;   // latest args, or null when nothing queued
        let timer = null;
        let last = 0;

        function run() {
            timer = null;
            if (!pending) return;
            const args = pending;
            pending = null;
            last = now();
            renderFn.apply(null, args);
        }

        function schedule() {
            pending = Array.prototype.slice.call(arguments);
            if (timer) return; // a render is already queued; it'll pick up the latest
            const wait = Math.max(0, intervalMs - (now() - last));
            timer = setTimeout(run, wait);
        }

        // Render the latest queued value immediately (e.g. when streaming ends).
        schedule.flush = function () {
            if (timer) { clearTimeout(timer); timer = null; }
            run();
        };
        // Drop any queued render (e.g. before a direct, authoritative innerHTML set).
        schedule.cancel = function () {
            if (timer) { clearTimeout(timer); timer = null; }
            pending = null;
        };
        return schedule;
    }

    global.createThrottledRenderer = createThrottledRenderer;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { createThrottledRenderer };
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
