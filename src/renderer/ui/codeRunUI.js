/**
 * Code run panel UI — status bar, review + Revert All (replaces plan drawer).
 *
 * v52.4: the status bar is now a LIVE indicator while a run is active — an animated
 * kawaii face + activity verb + cumulative tokens, e.g.
 *   (⊙_⊙) writing code…  ↓ 12.3k t · Plan 2/4 · Turn 7
 * Faces cycle while the run is live; everything freezes to a plain summary when it ends.
 * v54.3: elapsed/generation timers removed from this line — they repainted on top of the
 * face-cycle repaint and read as glitchy jumps (see render()).
 */
(function (global) {
    'use strict';

    const FACES = ['(⊙_⊙)', '(•_•)', '(¬‿¬)', '(◕‿◕)', '(°▽°)'];
    const FACE_INTERVAL_MS = 650;

    let liveEl = null;
    let lastStatus = {};
    let timer = null;
    // v52.7: genState — LIVE TOKEN-GENERATION state for the in-flight request, driven by
    // wire events only (streamSignals / streamCompletion onState), so it is identical for
    // every model family LM Studio can serve: 'waiting' = prompt processing / first-token
    // window, 'generating' = tokens flowing. While either is up, the reply must not be cut off.
    const liveState = { active: false, faceIdx: 0, verb: '', tokensTotal: null, genState: 'idle' };

    function routeEvent(type) {
        if (type === 'tool_start' || type === 'tool_result' || type === 'delta') return 'timeline';
        return 'code-panel';
    }

    function renderReviewPanel(container, diffText, sessionId, onRevert) {
        if (!container) return;
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'code-review-panel';
        wrap.innerHTML = `
            <div class="code-review-header">Code Run Review</div>
            <pre class="code-diff">${escapeHtml(diffText || '(no file changes)')}</pre>
            <button type="button" class="test-btn code-revert-btn">REVERT ALL</button>
        `;
        wrap.querySelector('.code-revert-btn')?.addEventListener('click', () => {
            if (onRevert) onRevert(sessionId);
        });
        container.appendChild(wrap);
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** 1234 → "1.2k", 1500000 → "1.5M" — compact token counter for the status line. */
    function fmtTokens(n) {
        if (n == null || !Number.isFinite(n)) return '';
        const v = Math.round(Number(n));
        if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
        if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
        return String(v);
    }

    function render() {
        if (!liveEl) return;
        const parts = [];
        if (liveState.active) {
            const face = FACES[liveState.faceIdx % FACES.length];
            let s = `${face} ${liveState.verb || 'working'}…`;
            // v54.3: the generation timer is HIDDEN. The "⚡ generating M:SS" segment toggled on and off
            // with every gen_state flip (waiting → generating → idle per tool call) while its clock text
            // changed every face cycle — two things repainting the same line at once, which read as a
            // glitchy jump in/out. The static "⚡ generating" / "⏳ processing prompt…" state still shows
            // whether tokens are flowing; no timer means nothing repaints just for a clock.
            if (liveState.genState === 'generating') {
                s += ' · ⚡ generating';
            } else if (liveState.genState === 'waiting') {
                s += ' · ⏳ processing prompt…';
            }
            const t = fmtTokens(liveState.tokensTotal);
            if (t) s += `  ↓ ${t} t`;
            parts.push(s);
        }
        const st = lastStatus || {};
        if (st.planProgress) parts.push(`Plan ${st.planProgress}`);
        if (st.turn != null) parts.push(`Turn ${st.turn}`);
        if (st.toolCount != null) parts.push(`${st.toolCount} tools`);
        if (st.budgetPct != null) parts.push(`ctx ${st.budgetPct}%`);
        liveEl.textContent = parts.join(' · ') || 'Code Mode idle';
    }

    function tick() {
        liveState.faceIdx++;
        render();
    }

    /** Begin the live indicator (face cycling). Idempotent. */
    function startLive(el, verb) {
        if (el) liveEl = el;
        liveState.active = true;
        liveState.faceIdx = 0;
        // v52.7: a fresh run starts in the prompt-processing window until the first token lands.
        liveState.genState = 'waiting';
        if (verb) liveState.verb = verb;
        else if (!liveState.verb) liveState.verb = 'working';
        if (!timer) timer = setInterval(tick, FACE_INTERVAL_MS);
        render();
    }

    /** Update the activity verb ("writing code", "verifying", …). */
    function setLiveVerb(verb) {
        if (liveState.active && verb) {
            liveState.verb = String(verb);
            render();
        }
    }

    /** Set cumulative run tokens from a server-reported usage event. */
    function setLiveTokens(n) {
        if (Number.isFinite(n)) {
            liveState.tokensTotal = n;
            render();
        }
    }

    // v52.7: LIVE GENERATION STATE — 'waiting' | 'generating' | 'idle'. Driven by the
    // in-flight request's wire events (gen_state from streamCompletion), model-agnostic.
    function setLiveGenState(state) {
        if (!liveState.active) return;
        const s = state === 'generating' ? 'generating' : (state === 'waiting' ? 'waiting' : 'idle');
        if (s !== liveState.genState) {
            liveState.genState = s;
            render();
        }
    }

    /** End the live indicator — face stops, line keeps the final summary parts. */
    function stopLive() {
        liveState.active = false;
        liveState.faceIdx = 0;
        liveState.verb = '';
        liveState.genState = 'idle';
        if (timer) { clearInterval(timer); timer = null; }
        render();
    }

    function updateStatusBar(el, st) {
        if (!el) return;
        liveEl = el;
        lastStatus = Object.assign({}, lastStatus, st || {});
        render();
    }

    const api = { routeEvent, renderReviewPanel, updateStatusBar, startLive, setLiveVerb, setLiveTokens, setLiveGenState, stopLive };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKCodeRunUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
