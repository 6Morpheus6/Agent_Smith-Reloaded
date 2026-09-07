/**
 * Per-turn tool call deduplication — short-circuit identical invocations.
 */
'use strict';

function callSignature(name, args) {
    return `${name}:${JSON.stringify(args || {})}`;
}

class TurnDedup {
    constructor() {
        this.seen = new Set();
        this.failed = new Set();
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

    recordResult(name, args, ok) {
        const sig = callSignature(name, args);
        if (ok) this.failed.delete(sig);
        else this.failed.add(sig);
    }

    clearFailures() {
        this.failed.clear();
    }
}

module.exports = { TurnDedup, callSignature };
