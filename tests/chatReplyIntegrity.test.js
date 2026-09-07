/**
 * v52.9 — chat reply integrity: "reply gets cut off + Error: Assignment to constant variable"
 *
 * Root cause (v52.7/v52.8): the live-generation badge timer was declared
 * `const genPaintTimer = setInterval(...)` but the stream-end cleanup does
 * `clearInterval(genPaintTimer); genPaintTimer = null;`. Assigning to a const
 * throws "Assignment to constant variable" on EVERY reply, at exactly the moment
 * tokens have finished streaming. The outer catch then replaced botDiv.innerHTML
 * with an error wall — wiping the answer that had just been painted. Hence:
 * replies looked cut off and every one ended in `Error: Assignment to constant variable`.
 *
 * v54.3 resolution: the 1 s badge ticker was REMOVED entirely (its only job was ticking a
 * per-second clock, which also made the pulse line jump). With no timer there is nothing to
 * declare let/const and nothing for stream-end cleanup to reassign — the bug class is gone at
 * its root. The guards below now assert it STAYS removed; section 2 still covers the general
 * "no const timer reassigned" class in case any other timer is ever added.
 *
 * node --check can't catch a const-assignment (it is a runtime TypeError), so this
 * guards it statically, same convention as rendererLoadOrder.test.js:
 *   1. the exact regression — genPaintTimer must not exist at all (v54.3 removed it);
 *   2. the whole bug CLASS — no `const` setInterval/setTimeout variable anywhere in
 *      app.js may ever be reassigned (a const timer that gets nulled/cleared-and-reset
 *      is always this same error wall waiting to happen);
 *   3. the blast-radius fix — a fault AFTER tokens flowed must degrade to
 *      "answer + error note", never wipe what already streamed, and must not record
 *      the partial reply twice in history.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const lines = src.split('\n');

// ── 1. the exact regression ───────────────────────────────────────────────────

test('genPaintTimer no longer exists (v54.3 removed the 1 s badge ticker that caused it)', () => {
    // The v52.9 bug lived in `const genPaintTimer = setInterval(...)` + a stream-end reassignment.
    // v54.3 deleted the timer outright, so the strongest guard is: no declaration of any kind —
    // neither const (the original bug) nor let/var (a reintroduced ticker would need its own cleanup).
    // (Comments may still mention the name for history; only a live declaration fails this.)
    assert.doesNotMatch(src, /\b(?:const|let|var)\s+genPaintTimer\b/, 'badge ticker was removed in v54.3 — do not reintroduce a per-second repaint writer');
});

test('no 1 s badge-ticker setInterval remains that repaints botDiv for the generation clock', () => {
    // The removed timer's signature: an interval whose callback rewrites botDiv.innerHTML purely to
    // tick the live-generation badge. If anyone re-adds a dedicated repaint ticker, this catches it so
    // the "multiple writers fighting for display" glitch (v54.3) does not come back.
    const ticker = src.match(/setInterval\(\s*\(\)\s*=>\s*\{[^}]*botDiv\.innerHTML\s*=.*?genBadge\(\)[^}]*\}\s*,\s*\d+\)/);
    assert.equal(ticker, null, 'a dedicated badge-ticker setInterval repainting botDiv was removed in v54.3');
});

// ── 2. the bug class: no const timer may ever be reassigned ───────────────────

test('no `const` setInterval/setTimeout variable is reassigned anywhere in app.js', () => {
    // name -> set of declaration line numbers (a name can be declared in several scopes)
    const declLines = new Map();
    lines.forEach((line, i) => {
        const m = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?(?:setInterval|setTimeout)\(/);
        if (!m) return;
        if (!declLines.has(m[1])) declLines.set(m[1], new Set());
        declLines.get(m[1]).add(i + 1);
    });

    const violations = [];
    lines.forEach((line, i) => {
        for (const name of declLines.keys()) {
            // A line that re-declares the same name in another scope is shadowing, not an assignment.
            if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(line)) continue;
            // an assignment to the timer var that is not its own declaration line.
            // `=(?!\s*[=>])` excludes comparisons (==) and arrow params (t =>); the decl line
            // itself is excluded by set membership.
            if (!new RegExp(`\\b${name}\\s*=(?!\\s*[=>])`).test(line)) continue;
            if (declLines.get(name).has(i + 1)) continue;
            violations.push(`${line.trim()}  (line ${i + 1})`);
        }
    });

    assert.deepEqual(violations, [], 'const timer reassigned — that is "Assignment to constant variable" at runtime:\n' + violations.join('\n'));
});

// ── 3. blast radius: a mid-reply fault must not wipe the streamed answer ──────

test('lastStreamedContent is declared OUTSIDE the try so the catch can see it', () => {
    const declIdx = src.search(/\blet\s+lastStreamedContent\s*=\s*''/);
    assert.ok(declIdx >= 0, 'must track the latest streamed reply text');
    // The stream's try block starts right after the declaration (persist() is its first call).
    const tryIdx = src.indexOf('try {\n        persist();', declIdx);
    assert.ok(tryIdx > declIdx, 'declaration must precede the streaming try/catch — inside it, catch could never see it');
});

test('emitStream records every streamed chunk into lastStreamedContent', () => {
    assert.match(src, /const emitStream = \(raw\) => \{ lastStreamedContent = raw;/);
});

test('fault after tokens flowed keeps the partial reply and appends the error (timeout + generic branches)', () => {
    // keepPartial() is idempotent: it only records to history if the final push never happened.
    assert.match(src, /const keepPartial = \(\) => \{/);
    assert.match(src, /if \(!lastStreamedContent \|\| !String\(lastStreamedContent\)\.trim\(\)\) return false;/);
    // Both non-abort error branches must APPEND to what is already painted, not replace it.
    const appends = src.match(/botDiv\.innerHTML = keepPartial\(\) \? `\$\{botDiv\.innerHTML\}<br><br>\$\{errorHtml\(msg\)\}` : errorHtml\(msg\);/g) || [];
    assert.equal(appends.length, 2, 'timeout and generic-error branches must both preserve the partial reply');
});

test('AbortError still discards (user asked to stop — no partial kept)', () => {
    const abortBranch = src.slice(src.indexOf("if (e.name === 'AbortError')"), src.indexOf("} else if", src.indexOf("if (e.name === 'AbortError')")));
    assert.doesNotMatch(abortBranch, /keepPartial/, 'an aborted run must not resurrect a partial reply');
});
