/**
 * Inline plan anchor — lightweight task text re-injected each turn.
 * When PlanArtifacts is attached, syncs notes to IMPLEMENT.md and includes PLAN excerpt.
 */
'use strict';

class PlanAnchor {
    constructor(goal, planArtifacts = null, ledger = null) {
        this.goal = goal || '';
        this.notes = [];
        this.completed = [];
        this.planArtifacts = planArtifacts;
        this.ledger = ledger || null;
    }

    setLedger(ledger) {
        this.ledger = ledger || null;
    }

    setPlanArtifacts(planArtifacts) {
        this.planArtifacts = planArtifacts;
    }

    recordDone(summary, meta = {}) {
        if (summary) this.completed.push(String(summary).slice(0, 200));
        // v54.5: durable progress ledger — every meaningful tool outcome recorded on disk.
        if (this.ledger?.record) {
            this.ledger.record({
                tool: meta.tool || 'step',
                ok: meta.ok !== false,
                ref: meta.ref ?? '',
                note: meta.note || ''
            });
        }
        if (this.planArtifacts?.enabled) {
            this.planArtifacts.appendImplementEntry({
                title: 'Tool success',
                what: summary || '(completed step)'
            }).catch(() => {});
        }
    }

    addNote(note) {
        if (!note) return Promise.resolve();
        this.notes.push(String(note).slice(0, 300));
        if (this.planArtifacts?.enabled) {
            return this.planArtifacts.appendImplementEntry({
                title: 'Note',
                what: String(note).slice(0, 500)
            }).catch(() => {});
        }
        return Promise.resolve();
    }

    toBlock() {
        const lines = ['[TASK]', this.goal];
        if (this.planArtifacts?.enabled) {
            const block = this.planArtifacts.toContextBlock();
            if (block) lines.push('', block);
        }
        // v54.5: the durable ledger is the stable track — injected every turn so a long
        // build/packaging run always knows what it already completed, even after compaction.
        const ledgerBlock = this.ledger?.toBlock ? this.ledger.toBlock() : '';
        if (ledgerBlock) lines.push('', ledgerBlock);
        if (this.completed.length && !ledgerBlock) {
            lines.push('', 'Done so far:');
            this.completed.slice(-5).forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
        }
        if (this.notes.length) {
            lines.push('', 'Notes:');
            this.notes.slice(-3).forEach(n => lines.push(`  - ${n}`));
        }
        return lines.join('\n');
    }

    serialize() {
        return {
            goal: this.goal,
            notes: this.notes,
            completed: this.completed
        };
    }

    restore(data) {
        if (!data) return;
        this.goal = data.goal || this.goal;
        this.notes = data.notes || [];
        this.completed = data.completed || [];
    }
}

module.exports = { PlanAnchor };
