/**
 * v54.5 — Progress Ledger: durable, on-disk memory of what a Code run has ACTUALLY done.
 *
 * The failure this fixes: long tasks (build → package into AppImage/.deb) get interrupted
 * (crash, stop, context loss). On resume or re-request the model had only PLAN.md prose and
 * a truncated "Done so far" list — it would redo finished steps, lose track of which build
 * already produced artifacts, and drift off-track. The ledger records every meaningful tool
 * outcome as a compact entry, persists under .agentsmith/ledgers/ keyed by goal hash, and is:
 *   - re-injected into the plan anchor block EVERY turn (stable track),
 *   - restored on resume from session state,
 *   - loaded from disk for a NEW run with the same goal (continuity after a crash).
 * Append-only, capped; last N entries render inline so the model always sees where it is.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 400;      // on-disk cap (oldest dropped)
const INLINE_ENTRIES = 25;    // rendered into the anchor block each turn

function normalizeGoal(goal) {
    return String(goal || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function goalHash(goal) {
    return crypto.createHash('sha1').update(normalizeGoal(goal)).digest('hex').slice(0, 16);
}

class ProgressLedger {
    /**
     * @param {object} o
     * @param {string} [o.projectRoot]  where .agentsmith/ lives (enables disk persistence)
     * @param {string} [o.goal]         task goal — the continuity key across runs
     */
    constructor({ projectRoot = null, goal = '' } = {}) {
        this.projectRoot = projectRoot;
        this.goal = String(goal || '');
        this.entries = [];
        this.startedAt = Date.now();
    }

    get enabled() { return !!this.projectRoot; }

    filePath() {
        if (!this.projectRoot) return null;
        return path.join(this.projectRoot, '.agentsmith', 'ledgers', `${goalHash(this.goal)}.json`);
    }

    /** Load a previous run's ledger for the same goal (crash/re-request continuity). */
    loadFromDisk() {
        const fp = this.filePath();
        if (!fp) return false;
        try {
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (Array.isArray(raw.entries)) {
                this.entries = raw.entries.slice(-MAX_ENTRIES);
                this.startedAt = raw.startedAt || this.startedAt;
                return this.entries.length > 0;
            }
        } catch (e) { /* no ledger yet — normal for a first run */ }
        return false;
    }

    save() {
        const fp = this.filePath();
        if (!fp) return;
        try {
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, JSON.stringify({
                goal: normalizeGoal(this.goal).slice(0, 300),
                startedAt: this.startedAt,
                updatedAt: Date.now(),
                entries: this.entries.slice(-MAX_ENTRIES)
            }), 'utf8');
        } catch (e) { /* persistence is best-effort; never break a run over it */ }
    }

    /** Record one outcome. ref = the file/command/subject, capped and single-line. */
    record({ tool, ok = true, ref = '', note = '' }) {
        if (!tool) return;
        const entry = {
            t: Date.now(),
            tool: String(tool).slice(0, 40),
            ok: !!ok,
            ref: String(ref).replace(/\s+/g, ' ').slice(0, 160),
            note: String(note).replace(/\s+/g, ' ').slice(0, 120)
        };
        // Collapse an immediate repeat of the same outcome (retry spam) into a count.
        const last = this.entries[this.entries.length - 1];
        if (last && last.tool === entry.tool && last.ok === entry.ok && last.ref === entry.ref) {
            last.n = (last.n || 1) + 1;
            last.t = entry.t;
        } else {
            this.entries.push(entry);
            if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
        this.save();
    }

    /** Compact "what has been done" summary for prompts and resume messages. */
    toBlock() {
        if (!this.entries.length) return '';
        const files = new Set();
        let buildsOk = 0, buildsFailed = 0, cmdsOk = 0, cmdsFailed = 0;
        for (const e of this.entries) {
            if ((e.tool === 'write_file' || e.tool === 'patch' || e.tool === 'append_file') && e.ok && e.ref) files.add(e.ref);
            const isBuild = /electron-builder|dist|package|pyinstaller|\bmake\b/i.test(e.ref);
            if (e.tool === 'run_command') {
                if (isBuild) { if (e.ok) buildsOk++; else buildsFailed++; }
                else { if (e.ok) cmdsOk++; else cmdsFailed++; }
            }
        }
        const lines = ['[PROGRESS LEDGER — durable record of what THIS task has done]'];
        const stats = [];
        if (files.size) stats.push(`${files.size} file(s) written`);
        if (cmdsOk || cmdsFailed) stats.push(`commands: ${cmdsOk} ok / ${cmdsFailed} failed`);
        if (buildsOk || buildsFailed) stats.push(`build/package runs: ${buildsOk} ok / ${buildsFailed} failed`);
        if (stats.length) lines.push(`Summary: ${stats.join('; ')}.`);
        lines.push('Recent steps (newest last):');
        for (const e of this.entries.slice(-INLINE_ENTRIES)) {
            const n = e.n > 1 ? ` x${e.n}` : '';
            lines.push(`  ${e.ok ? '✓' : '✗'} ${e.tool}${n}${e.ref ? ` — ${e.ref}` : ''}${!e.ok && e.note ? ` (${e.note})` : ''}`);
        }
        lines.push('Do NOT redo steps already marked ✓. Continue from where the ledger stopped.');
        return lines.join('\n');
    }

    serialize() {
        return { goal: this.goal, startedAt: this.startedAt, entries: this.entries.slice(-MAX_ENTRIES) };
    }

    restore(data) {
        if (!data) return;
        if (data.goal && !this.goal) this.goal = data.goal;
        if (Array.isArray(data.entries)) this.entries = data.entries.slice(-MAX_ENTRIES);
        if (data.startedAt) this.startedAt = data.startedAt;
    }
}

module.exports = { ProgressLedger, goalHash };
