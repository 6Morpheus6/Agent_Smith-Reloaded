/**
 * Chat scroll follow — auto-scroll during agent runs with a jump-to-latest pill.
 *
 * - Pinned to bottom while the user is near the latest content
 * - User scroll-up pauses follow and shows a "Latest" jump pill
 * - Active runs force-pin until the user explicitly scrolls away
 * - Instant scroll (no smooth lag) while following; rAF + ResizeObserver coalescing
 */
(function (global) {
    'use strict';

    const DEFAULT_THRESHOLD = 96;

    /** Pure logic for unit tests. */
    function shouldAutoScroll({ nearBottom, force }) {
        if (force) return true;
        return nearBottom;
    }

    function distanceFromBottom(el) {
        if (!el) return 0;
        return el.scrollHeight - el.scrollTop - el.clientHeight;
    }

    function isNearBottom(el, threshold) {
        const t = threshold || DEFAULT_THRESHOLD;
        // Small epsilon — subpixel layout and flex gaps can leave 1–2px off true bottom.
        return distanceFromBottom(el) <= t + 2;
    }

    function createScrollFollow(container, hostEl, opts) {
        const threshold = (opts && opts.threshold) || DEFAULT_THRESHOLD;
        let pinned = true;
        let runActive = false;
        let rafId = null;
        let ro = null;
        let btn = null;

        function ensureButton() {
            if (btn || !hostEl) return btn;
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'scroll-follow-btn';
            btn.hidden = true;
            btn.setAttribute('aria-label', 'Jump to latest activity');
            btn.innerHTML = '<span class="scroll-follow-icon">↓</span><span class="scroll-follow-label">Latest</span>';
            btn.addEventListener('click', () => {
                pinned = true;
                follow({ force: true });
                updateButton();
            });
            hostEl.appendChild(btn);
            return btn;
        }

        function updateButton() {
            ensureButton();
            if (!btn) return;
            // Show whenever the user is scrolled away from the bottom, regardless
            // of whether a run is active. The pill is purely a "jump to latest"
            // affordance — it should disappear the moment the user is at bottom.
            const show = !isNearBottom(container, threshold);
            btn.hidden = !show;
            if (show) {
                btn.classList.toggle('scroll-follow-btn--live', runActive);
            }
        }

        function applyScrollInstant() {
            if (!container) return;
            const prev = container.style.scrollBehavior;
            container.style.scrollBehavior = 'auto';
            container.scrollTop = container.scrollHeight;
            container.style.scrollBehavior = prev;
            updateButton();
        }

        function scheduleScroll() {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                requestAnimationFrame(() => {
                    applyScrollInstant();
                    updateButton();
                });
            });
        }

        function follow(options) {
            if (!container) return;

            const force = !!(options && options.force);
            const near = isNearBottom(container, threshold);

            if (force) {
                pinned = true;
                scheduleScroll();
                updateButton();
                return;
            }

            if (shouldAutoScroll({ nearBottom: near, force: false })) {
                pinned = true;
                scheduleScroll();
            } else {
                pinned = false;
            }
            updateButton();
        }

        function beginRun() {
            runActive = true;
            pinned = true;
            container?.classList.add('messages--following');
            ensureButton();
            follow({ force: true });
            if (typeof ResizeObserver !== 'undefined' && container && !ro) {
                ro = new ResizeObserver(() => {
                    if (runActive || pinned) follow();
                });
                ro.observe(container);
            }
        }

        function endRun() {
            runActive = false;
            container?.classList.remove('messages--following');
            updateButton();
        }

        function onScroll() {
            const near = isNearBottom(container, threshold);
            if (near) {
                pinned = true;
            } else {
                pinned = false;
            }
            updateButton();
        }

        function destroy() {
            endRun();
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            if (ro) {
                ro.disconnect();
                ro = null;
            }
            if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
            btn = null;
            container?.removeEventListener('scroll', onScroll);
        }

        if (container) {
            container.addEventListener('scroll', onScroll, { passive: true });
            // Sync pill visibility once layout is known (hidden when already at bottom).
            requestAnimationFrame(() => {
                requestAnimationFrame(() => updateButton());
            });
        }

        return {
            follow,
            beginRun,
            endRun,
            destroy,
            isPinned: () => pinned,
            isRunActive: () => runActive,
            _test: { pinned: () => pinned, setPinned: (v) => { pinned = v; } }
        };
    }

    let instance = null;

    function mount(container, hostEl, opts) {
        if (instance) instance.destroy();
        instance = createScrollFollow(container, hostEl, opts);
        return instance;
    }

    function get() {
        return instance;
    }

    const api = {
        mount,
        get,
        createScrollFollow,
        shouldAutoScroll,
        isNearBottom,
        distanceFromBottom,
        DEFAULT_THRESHOLD
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKScrollFollow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
