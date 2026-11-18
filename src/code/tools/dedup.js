/**
 * Per-turn tool call deduplication — short-circuit identical invocations.
 *
 * Two memories with deliberately different scopes:
 *   - `seen`   — cleared every turn. An identical request twice in ONE batch is a
 *                duplicate: the first answer is already in history.
 *   - `failed` — survives turn boundaries. Re-sending byte-identical arguments that
 *                already failed cannot succeed, so the model must change the request.
 *
 * The `failed` memory must be UNLOCKABLE, or one failed write becomes a permanent dead
 * end: the harness tells the model to read the file and retry, the retry arrives with the
 * same arguments, and it is swallowed as a "duplicate" — with the reason text claiming
 * "this turn" although the block spans the whole run (the v56.5.2 Super Mario run: the
 * first write_file failed on a missing `content` and every corrected-by-prose retry was
 * deduped away). A successful read of that path — exactly the step the harness demands
 * after a failed edit — or a successful write clears the block.
 */
'use strict';

function callSignature(name, args) {
    return `${name}:${JSON.stringify(args || {})}`;
}

function normPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

class TurnDedup {
    constructor() {
        this.seen = new Set();
        this.failed = new Map(); // signature -> { path, reason }
    }

    reset() {
        this.seen.clear();
    }

    isDuplicate(name, args) {
        const sig = callSignature(name, args);
        if (this.seen.has(sig) || this.failed.has(sig)) return true;
        this.seen.add(sig);
        return false;
    }

    /** Why an identical call is blocked — null when it is only a same-turn duplicate. */
    failureReason(name, args) {
        const rec = this.failed.get(callSignature(name, args));
        return rec ? String(rec.reason || '') : null;
    }

    recordResult(name, args, ok, detail) {
        const sig = callSignature(name, args);
        if (ok) {
            this.failed.delete(sig);
            return;
        }
        const reason = detail && typeof detail === 'object'
            ? (detail.error || detail.reason || detail.message || '')
            : (detail || '');
        this.failed.set(sig, {
            path: normPath(args && args.path),
            reason: String(reason).slice(0, 300)
        });
    }

    /** Unlock retries for one path once the model has re-inspected or rewritten it. */
    clearFailuresForPath(p) {
        const target = normPath(p);
        if (!target) return;
        for (const [sig, rec] of this.failed) {
            if (rec.path && rec.path === target) this.failed.delete(sig);
        }
    }

    clearFailures() {
        this.failed.clear();
    }
}

module.exports = { TurnDedup, callSignature };
