/**
 * sidebarLayout — collapsible settings sections + mobile settings overlay.
 */
(function (global) {
    const COLLAPSE_KEY = 'agentsmith_section_collapsed';
    const LEGACY_COLLAPSE_KEY = 'xkaliber_section_collapsed';
    const MOBILE_MQ = '(max-width: 768px)';

    const state = { layout: 'desktop', wired: false };

    function $(id) { return document.getElementById(id); }
    function isMobile() { return window.matchMedia(MOBILE_MQ).matches; }

    function loadCollapsed() {
        try {
            const raw = localStorage.getItem(COLLAPSE_KEY) || localStorage.getItem(LEGACY_COLLAPSE_KEY) || '{}';
            return JSON.parse(raw) || {};
        }
        catch (e) { return {}; }
    }
    function saveCollapsed(map) {
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); } catch (e) {}
    }
    function applyPersistedCollapse() {
        const map = loadCollapsed();
        document.querySelectorAll('.xk-section').forEach(sec => {
            const key = sec.dataset.section;
            sec.classList.toggle('collapsed', !!map[key]);
        });
    }
    function wireSections() {
        document.querySelectorAll('.xk-section-header').forEach(header => {
            header.addEventListener('click', () => {
                const sec = header.closest('.xk-section');
                if (!sec) return;
                const key = sec.dataset.section;
                const collapsed = sec.classList.toggle('collapsed');
                const map = loadCollapsed();
                map[key] = collapsed;
                saveCollapsed(map);
            });
        });
        applyPersistedCollapse();
    }

    function applyLayout() {
        const next = isMobile() ? 'mobile' : 'desktop';
        state.layout = next;
        document.body.classList.toggle('xk-mobile', next === 'mobile');
        if (next === 'desktop') closeSettings();
    }

    function openSettings() {
        document.body.classList.add('xk-sidebar-open');
    }
    function closeSettings() {
        document.body.classList.remove('xk-sidebar-open');
    }

    function init() {
        if (state.wired) return;
        state.wired = true;
        wireSections();

        const hamburger = $('hamburger-btn');
        if (hamburger) hamburger.addEventListener('click', openSettings);
        const sbBackdrop = $('sidebar-backdrop');
        if (sbBackdrop) sbBackdrop.addEventListener('click', closeSettings);

        window.matchMedia(MOBILE_MQ).addEventListener('change', applyLayout);
        applyLayout();
    }

    function clearCodeReviewMount() {
        const el = document.getElementById('code-review-mount');
        if (el) el.innerHTML = '';
    }

    function enterPlanMode({ stepLabel } = {}) {
        document.body.classList.add('xk-run-active');
        clearCodeReviewMount();
        // Reset sidebar scroll so the absolute-positioned drawer aligns with the
        // visible viewport instead of sitting above a scrolled position.
        const sb = document.getElementById('sidebar');
        if (sb) sb.scrollTop = 0;
        const drawer = $('plan-drawer');
        const chip = $('plan-chip');
        if (drawer) {
            drawer.style.display = 'flex';
            drawer.setAttribute('aria-hidden', 'false');
        }
        if (chip) chip.style.display = 'none';
        if (stepLabel != null) updatePlanChip(stepLabel);
    }

    function collapsePlanDrawer() {
        const drawer = $('plan-drawer');
        const chip = $('plan-chip');
        if (drawer) {
            drawer.style.display = 'none';
            drawer.setAttribute('aria-hidden', 'true');
        }
        if (chip) chip.style.display = 'block';
    }

    function openPlanDrawer() {
        enterPlanMode({ stepLabel: $('plan-chip-step')?.textContent?.replace(/^·\s*/, '') || '' });
    }

    function exitPlanMode() {
        document.body.classList.remove('xk-run-active');
        const drawer = $('plan-drawer');
        const chip = $('plan-chip');
        if (drawer) {
            drawer.style.display = 'none';
            drawer.setAttribute('aria-hidden', 'true');
        }
        if (chip) chip.style.display = 'none';
    }

    function updatePlanChip(label) {
        const el = $('plan-chip-step');
        if (el) el.textContent = `· ${label}`;
    }

    function enterPreviewMode({ label } = {}) {
        exitPlanMode();
        document.body.classList.add('xk-preview-active');
        const sb = document.getElementById('sidebar');
        if (sb) sb.scrollTop = 0;
        const drawer = $('preview-drawer');
        const chip = $('preview-chip');
        if (drawer) {
            drawer.style.display = 'flex';
            drawer.setAttribute('aria-hidden', 'false');
        }
        if (chip) chip.style.display = 'none';
        if (label != null) updatePreviewChip(label);
    }

    function collapsePreviewDrawer() {
        const drawer = $('preview-drawer');
        const chip = $('preview-chip');
        if (drawer) {
            drawer.style.display = 'none';
            drawer.setAttribute('aria-hidden', 'true');
        }
        if (chip && document.body.classList.contains('xk-preview-active')) chip.style.display = 'block';
    }

    function openPreviewDrawer() {
        enterPreviewMode({ label: $('preview-chip-label')?.textContent?.replace(/^·\s*/, '') || '' });
    }

    function exitPreviewMode() {
        document.body.classList.remove('xk-preview-active');
        const drawer = $('preview-drawer');
        const chip = $('preview-chip');
        if (drawer) {
            drawer.style.display = 'none';
            drawer.setAttribute('aria-hidden', 'true');
        }
        if (chip) chip.style.display = 'none';
    }

    function updatePreviewChip(label) {
        const el = $('preview-chip-label');
        if (el) el.textContent = `· ${label}`;
    }

    const api = {
        init, openSettings, closeSettings, isMobile,
        enterPlanMode, collapsePlanDrawer, openPlanDrawer, exitPlanMode, updatePlanChip,
        enterPreviewMode, collapsePreviewDrawer, openPreviewDrawer, exitPreviewMode, updatePreviewChip
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKSidebarLayout = api;
    else if (typeof global !== 'undefined') global.XKSidebarLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
