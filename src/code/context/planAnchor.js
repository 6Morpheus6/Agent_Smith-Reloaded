/**
 * Inline plan anchor — lightweight task text re-injected each turn.
 * When PlanArtifacts is attached, syncs notes to IMPLEMENT.md and includes PLAN excerpt.
 */
'use strict';

class PlanAnchor {
    constructor(goal, planArtifacts = null) {
        this.goal = goal || '';
        this.notes = [];
        this.completed = [];
        this.planArtifacts = planArtifacts;
    }

    setPlanArtifacts(planArtifacts) {
        this.planArtifacts = planArtifacts;
    }

    recordDone(summary) {
        if (summary) this.completed.push(String(summary).slice(0, 200));
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
        if (this.completed.length) {
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
