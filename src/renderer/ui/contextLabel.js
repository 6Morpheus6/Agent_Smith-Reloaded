/**
 * contextLabel — reflect the selected workspace into the cockpit folder button.
 *
 * app.js writes the full path into #workspace-status (e.g. "📁 Workspace: C:\…\PAc")
 * but never updates the folder button itself, so it would always read "Set project folder".
 * Rather than touch app.js, we observe #workspace-status and mirror the BASENAME onto
 * the button label (with the full path as its tooltip). The verbose path line is hidden by
 * CSS; the button + tooltip carry the same information.
 *
 * Purely presentational and self-contained — safe across app.js changes.
 */
(function () {
    'use strict';

    function basename(p) {
        const parts = String(p).split(/[\\/]+/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
    }

    function init() {
        const status = document.getElementById('workspace-status');
        const btn = document.getElementById('here-i-am-btn');
        const label = btn && btn.querySelector('.ws-pin-label');
        if (!status || !btn || !label) return;

        function update() {
            const text = (status.textContent || '').trim();
            const m = text.match(/Workspace:\s*(.+)$/);
            if (m && m[1]) {
                const full = m[1].trim();
                label.textContent = basename(full) || full;
                btn.title = full;
                btn.classList.add('ctx-folder--set');
            } else {
                label.textContent = 'Set project folder';
                btn.title = 'Set the project folder Agent Smith works in';
                btn.classList.remove('ctx-folder--set');
            }
        }

        update();
        new MutationObserver(update).observe(status, {
            childList: true, characterData: true, subtree: true, attributes: true
        });
    }

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})();
