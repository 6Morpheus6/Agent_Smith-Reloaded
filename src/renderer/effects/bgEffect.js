/* ============================================================================
   Agent Smith — Matrix "code rain" background
   Faint falling columns of half-width katakana + Latin glyphs (the classic
   Matrix digital rain), colored from the active theme accent and faded against
   the theme background. Subtle by design so it sits behind the chat without
   hurting readability.
   Self-contained: prepends a fixed, pointer-events:none canvas behind the UI.
   ========================================================================== */
(function () {
    'use strict';

    // Classic Matrix rain charset: half-width katakana (U+FF66–U+FF9D) mixed with
    // Latin digits and a few code symbols — the film's mirrored-katakana look.
    const GLYPHS = (function () {
        const out = [];
        for (let c = 0xFF66; c <= 0xFF9D; c++) out.push(String.fromCharCode(c));
        return out.concat('0123456789ABCDEFZ:.=*+-<>'.split(''));
    })();

    function hexToRgb(hex) {
        if (!hex) return null;
        hex = hex.trim().replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
        if (hex.length < 6) return null;
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if ([r, g, b].some(isNaN)) return null;
        return { r, g, b };
    }
    function rand(min, max) { return min + Math.random() * (max - min); }
    function glyph() { return GLYPHS[(Math.random() * GLYPHS.length) | 0]; }

    function start() {
        if (document.getElementById('xk-bg-canvas')) return;

        const reduceMotion = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const canvas = document.createElement('canvas');
        canvas.id = 'xk-bg-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
        document.body.prepend(canvas);

        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const FONT = 16;          // glyph cell size in px
        let W = 0, H = 0, cols = 0;
        let drops = [];           // head row (fractional) per column
        let speeds = [];          // rows/frame per column
        let nextGlyph = [];       // frames until this column swaps its head glyph

        function reset(i, top) {
            drops[i] = top ? rand(-40, 0) : rand(-40, -2);
            speeds[i] = rand(0.18, 0.55);   // calm fall
            nextGlyph[i] = (rand(2, 7)) | 0;
        }

        function resize() {
            W = window.innerWidth;
            H = window.innerHeight;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.font = FONT + "px 'JetBrains Mono','Fira Code',Consolas,monospace";
            ctx.textBaseline = 'top';
            const newCols = Math.ceil(W / FONT);
            if (newCols !== cols) {
                cols = newCols;
                drops = new Array(cols);
                speeds = new Array(cols);
                nextGlyph = new Array(cols);
                heads = new Array(cols);
                for (let i = 0; i < cols; i++) { reset(i, true); heads[i] = glyph(); }
            }
        }

        let heads = [];

        function css(name, fallback) {
            const v = getComputedStyle(document.documentElement)
                .getPropertyValue(name).trim();
            return v || fallback;
        }
        function accent() { return css('--bg-effect-color', '') || css('--accent-color', '#15ff5f'); }

        let cachedBg = '', fadeStyle = 'rgba(10,10,10,0.10)';
        function fade() {
            const bg = css('--bg-color', '#0a0a0a');
            if (bg !== cachedBg) {
                cachedBg = bg;
                const rgb = hexToRgb(bg) || { r: 10, g: 10, b: 10 };
                // Alpha controls trail length: higher = shorter, crisper tails.
                fadeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.10)`;
            }
            return fadeStyle;
        }
        function dimColor(a) {
            const rgb = hexToRgb(accent()) || { r: 21, g: 255, b: 95 };
            return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
        }

        resize();
        window.addEventListener('resize', resize);

        function draw() {
            requestAnimationFrame(draw);

            // Fade the whole frame toward the background to leave glyph trails.
            ctx.fillStyle = fade();
            ctx.fillRect(0, 0, W, H);

            const headColor = accent();
            for (let i = 0; i < cols; i++) {
                const x = i * FONT;
                const y = drops[i] * FONT;

                if (y > 0 && y < H) {
                    // Trailing glyph just behind the head — dim.
                    ctx.fillStyle = dimColor(0.16);
                    ctx.fillText(glyph(), x, y - FONT);

                    // Bright leading glyph with a soft glow.
                    if (--nextGlyph[i] <= 0) { heads[i] = glyph(); nextGlyph[i] = (rand(2, 7)) | 0; }
                    ctx.fillStyle = headColor;
                    ctx.globalAlpha = 0.7;
                    ctx.shadowColor = headColor;
                    ctx.shadowBlur = 6;
                    ctx.fillText(heads[i], x, y);
                    ctx.shadowBlur = 0;
                    ctx.globalAlpha = 1;
                }

                drops[i] += speeds[i];
                // Recycle the column a little after it leaves the screen.
                if (y > H && Math.random() > 0.975) reset(i, false);
            }
        }

        if (reduceMotion) {
            // Static sparse field — present, but no motion.
            ctx.fillStyle = css('--bg-color', '#0a0a0a');
            ctx.fillRect(0, 0, W, H);
            for (let i = 0; i < cols; i++) {
                const x = i * FONT;
                const n = (rand(2, Math.max(3, H / FONT))) | 0;
                for (let k = 0; k < n; k += (rand(3, 7) | 0)) {
                    ctx.fillStyle = dimColor(rand(0.05, 0.2));
                    ctx.fillText(glyph(), x, k * FONT);
                }
            }
        } else {
            draw();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
