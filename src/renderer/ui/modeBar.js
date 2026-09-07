/**
 * Mode bar — drives the existing (now hidden) mode/modifier checkboxes from a compact
 * Matrix segmented control + chip row. app.js owns the real behaviour and is wired
 * to the checkbox IDs via `change` listeners; this module only sets `.checked` and fires
 * `change`, then mirrors state back into the segmented control / chips. Purely presentational.
 */
(function (global) {
    'use strict';

    function init() {
        const code = document.getElementById('code-mode-toggle');
        const agent = document.getElementById('agent-toggle');
        const segs = Array.prototype.slice.call(document.querySelectorAll('.mode-seg'));
        const chips = Array.prototype.slice.call(document.querySelectorAll('.mode-chip[data-toggle]'));
        if (!segs.length && !chips.length) return;

        const fire = (el) => { if (el) el.dispatchEvent(new Event('change', { bubbles: true })); };

        function currentMode() {
            // v50: single unified harness — the bar is presentational and always shows code.
            if (code && code.checked) return 'code';
            if (agent && agent.checked) return 'agent';
            return 'code';
        }

        function sync() {
            const m = currentMode();
            // Locked ONLY when a run is active (both checkboxes disabled by setCodeLock).
            // Normal mutual-exclusion disables just the *other* mode's checkbox, which must
            // NOT disable the segments — a disabled <button> won't fire click, freezing the
            // whole control once you're in any mode.
            const locked = !!(code && agent && code.disabled && agent.disabled);
            segs.forEach((s) => {
                s.classList.toggle('active', s.dataset.mode === m);
                s.disabled = locked;
            });
            chips.forEach((c) => {
                const t = document.getElementById(c.dataset.toggle);
                c.classList.toggle('active', !!(t && t.checked));
                c.disabled = !!(t && t.disabled);
            });
        }

        function setMode(mode) {
            if (!code || !agent) return;
            // Both disabled === a run is in progress (setCodeLock). Don't switch then.
            // (Only ONE being disabled is the normal mutual-exclusion lock, which we
            // are about to change, so that must NOT block the switch.)
            if (code.disabled && agent.disabled) return;
            // Turn the CURRENT mode off first. app.js exclusivity re-enables the
            // other checkbox on that change, so the target is enabled when we set it —
            // otherwise its change handler (which bails on .disabled) would no-op.
            if (mode !== 'code' && code.checked) { code.checked = false; fire(code); }
            if (mode !== 'agent' && agent.checked) { agent.checked = false; fire(agent); }
            if (mode === 'code' && !code.checked && !code.disabled) { code.checked = true; fire(code); }
            if (mode === 'agent' && !agent.checked && !agent.disabled) { agent.checked = true; fire(agent); }
            sync();
        }

        segs.forEach((s) => s.addEventListener('click', () => setMode(s.dataset.mode)));
        chips.forEach((c) => c.addEventListener('click', () => {
            const t = document.getElementById(c.dataset.toggle);
            if (!t || t.disabled) return;
            t.checked = !t.checked;
            fire(t);
            sync();
        }));

        // Mirror any external flips (saved-state restore, run lock, mutual exclusion).
        [code, agent].concat(chips.map((c) => document.getElementById(c.dataset.toggle)))
            .filter(Boolean)
            .forEach((el) => el.addEventListener('change', sync));

        sync();
        // app.js restores saved state slightly after load; re-mirror once it has.
        setTimeout(sync, 0);
        setTimeout(sync, 300);
    }

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);

    global.XKModeBar = { /* presentational; no public API */ };
})(typeof window !== 'undefined' ? window : globalThis);
