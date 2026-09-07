/**
 * Quality monitor — track tool success rate and nudge context on degradation.
 */
'use strict';

class QualityMonitor {
    constructor() {
        this.total = 0;
        this.success = 0;
        this.errors = [];
    }

    record(name, ok, detail) {
        this.total++;
        if (ok) this.success++;
        else this.errors.push({ name, detail: String(detail || '').slice(0, 200), ts: Date.now() });
        if (this.errors.length > 10) this.errors.shift();
    }

    successRate() {
        return this.total ? this.success / this.total : 1;
    }

    hintBlock() {
        if (this.successRate() >= 0.5 || this.total < 3) return '';
        const recent = this.errors.slice(-3).map(e => `- ${e.name}: ${e.detail}`).join('\n');
        return `[QUALITY WARNING] Tool success rate is low (${Math.round(this.successRate() * 100)}%). Recent errors:\n${recent}\nRe-read files before patching.`;
    }
}

module.exports = { QualityMonitor };
