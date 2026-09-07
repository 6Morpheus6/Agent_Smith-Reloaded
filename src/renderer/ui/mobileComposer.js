/**
 * mobileComposer — v52 floating chat input for the mobile web UI.
 *
 * On narrow (phone) viewports the normal bottom `.input-area` can be pushed off /
 * unreachable (iOS `100vh` + dynamic browser chrome). This module adds a persistent
 * floating button (FAB) that expands into the REAL chat input + SEND button and
 * collapses again on the next tap.
 *
 * It does NOT create new controls: it relocates the existing #user-input / #send-btn /
 * #stop-btn nodes into the floating bar, so every bit of app.js wiring (sendMessage on
 * click, Enter-to-send, the online/disabled sync) follows the elements unchanged. On a
 * wide viewport the nodes are moved back and nothing about desktop changes.
 *
 * v52: the expanded bar carries its own ✕ close button (#mc-close). In v51.9 the FAB
 * was the only toggle, but opening hid it (opacity 0 + pointer-events none), so once
 * expanded there was no way to dismiss it — the sheet stayed pinned over the chat and
 * the agent's reply could never be scrolled back into view. Open/close state now lives
 * in one setOpen() that both the FAB and the close button drive, and closing blurs the
 * input so the mobile keyboard goes away with the sheet.
 *
 * Self-contained IIFE + window global, matching contextLabel.js / sidebarLayout.js.
 */
(function () {
    'use strict';

    var MQ = '(max-width: 768px)'; // same breakpoint as base.css mobile rules
    var RELOCATE_IDS = ['user-input', 'send-btn', 'stop-btn'];

    var composer = null;
    var fab = null;
    var bar = null;
    var closeBtn = null;
    var moved = [];   // { el, parent, next } — enough to restore on desktop
    var active = false;

    function findComposer() {
        composer = document.getElementById('mobile-composer');
        fab = document.getElementById('mc-fab');
        bar = document.getElementById('mc-bar');
        closeBtn = document.getElementById('mc-close');
    }

    function isMobile() {
        return !!(window.matchMedia && window.matchMedia(MQ).matches);
    }

    // Move the real input/send/stop nodes into the floating bar. Listeners attached by
    // app.js live on the element nodes, so they survive reparenting.
    function moveIn() {
        moved = [];
        for (var i = 0; i < RELOCATE_IDS.length; i++) {
            var el = document.getElementById(RELOCATE_IDS[i]);
            if (!el || !el.parentNode) continue;
            moved.push({ el: el, parent: el.parentNode, next: el.nextSibling });
            bar.appendChild(el);
        }
    }

    // Restore the nodes to their original parents (desktop / wide viewport).
    function moveOut() {
        for (var i = 0; i < moved.length; i++) {
            var m = moved[i];
            if (!m.parent) continue;
            if (m.next && m.next.parentNode === m.parent) m.parent.insertBefore(m.el, m.next);
            else m.parent.appendChild(m.el);
        }
        moved = [];
    }

    function activate() {
        if (active || !isMobile()) return;
        findComposer();
        if (!composer || !fab || !bar) return;
        moveIn();
        document.body.classList.add('mobile-composer');
        composer.hidden = false;
        active = true;
    }

    function deactivate() {
        if (!active) return;
        if (composer) composer.classList.remove('open');
        moveOut();
        document.body.classList.remove('mobile-composer');
        if (composer) composer.hidden = true;
        active = false;
    }

    // Single source of truth for open/close state. Both the FAB and the bar's ✕ button
    // drive it, so they can never disagree (v51.9 bug: opening hid the only toggle —
    // the FAB itself — leaving no way to close the sheet).
    function setOpen(open) {
        if (!composer || !fab) return;
        composer.classList.toggle('open', open);
        fab.setAttribute('aria-label', open ? 'Close chat input' : 'Open chat input');
        fab.textContent = open ? '\u2715' /* ✕ */ : '\uD83D\uDCAC'; /* 💬 */
        if (open) {
            var inp = document.getElementById('user-input');
            if (inp) setTimeout(function () { try { inp.focus(); } catch (_) {} }, 60);
        } else {
            // Dismiss: drop focus so the mobile keyboard goes away with the sheet.
            var outp = document.getElementById('user-input');
            if (outp && typeof outp.blur === 'function') { try { outp.blur(); } catch (_) {} }
        }
    }

    function onFabClick() {
        if (!composer || !fab) return;
        setOpen(!composer.classList.contains('open'));
    }

    function onCloseClick() {
        if (!composer || !fab) return;
        setOpen(false);
    }

    function onMqChange(e) {
        if (e.matches) activate(); else deactivate();
    }

    function init() {
        findComposer();
        if (!composer || !fab || !bar) return; // DOM contract missing — no-op, never break the page
        fab.addEventListener('click', onFabClick);
        if (closeBtn) closeBtn.addEventListener('click', onCloseClick);
        var mql = window.matchMedia(MQ);
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onMqChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onMqChange); // older Safari
        if (isMobile()) activate();
    }

    window.XKMobileComposer = { init: init, _activate: activate, _deactivate: deactivate, _setOpen: setOpen };

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})();
