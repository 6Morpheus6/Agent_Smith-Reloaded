/**
 * Durable PLAN.md / IMPLEMENT.md artifacts under .agentsmith/ in the project root.
 * Long-lived task state lives in files, not only in the prompt.
 */
'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const ARTIFACT_DIR = '.agentsmith';
const PLAN_FILE = 'PLAN.md';
const IMPLEMENT_FILE = 'IMPLEMENT.md';

const MILESTONE_RE = /^-\s*\[([ xX])\]\s*\*\*(M\d+|Final)[^*]*\*\*[^|]*\|\s*verify:\s*`([^`]+)`/gm;
const MILESTONE_E2E_RE = /^-\s*\[([ xX])\]\s*\*\*(M\d+|Final)[^*]*\*\*[^|]*\|\s*e2e:\s*`([^`]+)`/gm;
const MILESTONE_SIMPLE = /^-\s*\[([ xX])\]\s*\*\*(M\d+|Final)/gm;

function artifactDir(projectRoot) {
    return path.join(projectRoot, ARTIFACT_DIR);
}

function planPath(projectRoot) {
    return path.join(artifactDir(projectRoot), PLAN_FILE);
}

function implementPath(projectRoot) {
    return path.join(artifactDir(projectRoot), IMPLEMENT_FILE);
}

function isNonTrivialTask(prompt, opts = {}) {
    if (opts.forcePlan) return true;
    const t = String(prompt || '').toLowerCase();
    if (/\b(build|create|implement|fix|refactor|add feature|scaffold|game|app|website|api)\b/.test(t)) return true;
    if (/\b(html|css|js|react|node|python|rust)\b/.test(t) && t.length > 40) return true;
    return t.length > 120;
}

function defaultPlanContent(goal) {
    const today = new Date().toISOString().slice(0, 10);
    return `# PLAN.md

> Task planning artifact. Updated as milestones are reached.

## Task

${goal.trim()}

## Context

Auto-created by Agent Smith Code Mode for a non-trivial task.

## Approach

Work incrementally: explore project layout, implement files, verify before declaring done.

## Milestones

Mark each milestone \`[x]\` when complete. Do not mark complete until the verification gate passes.

- [ ] **M1: Explore** — understand project layout and constraints | verify: \`list_project once\`
- [ ] **M2: Implement** — create or fix required files | verify: \`syntax + references resolve\`
- [ ] **Final: all checks pass** — verify: \`harness completion gate\`

## Scope boundaries

In scope:
- Files required to satisfy the task goal

Out of scope (explicitly excluded from this task):
- Unrelated refactors unless required for the goal

## Open questions

- [ ] (none yet)

## Risks

- Small local models may truncate files — harness syntax gate will block premature done.

## Notes

---

*Created: ${today}*
`;
}

function defaultImplementContent(goal) {
    return `# IMPLEMENT.md

> Implementation log. Append-only — do not edit past entries.

## Task reference

${goal.trim()}

---

## Log

<!-- Add new entries above this line. Oldest entries at the bottom. -->

## Deviations summary

| Deviation | Reason | Plan updated? |
|---|---|---|
| | | |

## Open questions (unresolved)

- [ ]

## Open questions (resolved)

| Question | Answer | Date |
|---|---|---|
| | | |
`;
}

class PlanArtifacts {
    constructor(projectRoot, goal, opts = {}) {
        this.projectRoot = projectRoot;
        this.goal = goal || '';
        this.enabled = false;
        this.milestones = [];
        this.milestoneIndex = 0;
        this._opts = opts;
    }

    static async ensure(projectRoot, goal, opts = {}) {
        const pa = new PlanArtifacts(projectRoot, goal, opts);
        if (!isNonTrivialTask(goal, opts)) return pa;

        const dir = artifactDir(projectRoot);
        await fsPromises.mkdir(dir, { recursive: true });

        const pPlan = planPath(projectRoot);
        const pImpl = implementPath(projectRoot);

        if (!fs.existsSync(pPlan)) {
            await fsPromises.writeFile(pPlan, defaultPlanContent(goal), 'utf-8');
        }
        if (!fs.existsSync(pImpl)) {
            await fsPromises.writeFile(pImpl, defaultImplementContent(goal), 'utf-8');
        }

        pa.enabled = true;
        pa.reloadMilestones();
        return pa;
    }

    static async load(projectRoot, goal) {
        const pa = new PlanArtifacts(projectRoot, goal);
        if (!fs.existsSync(planPath(projectRoot))) return pa;
        pa.enabled = true;
        pa.reloadMilestones();
        return pa;
    }

    reloadMilestones() {
        this.milestones = [];
        if (!this.enabled) return;
        let text = '';
        try { text = fs.readFileSync(planPath(this.projectRoot), 'utf-8'); } catch (e) { return; }

        let m;
        MILESTONE_RE.lastIndex = 0;
        while ((m = MILESTONE_RE.exec(text)) !== null) {
            this.milestones.push({
                id: m[2],
                done: m[1].toLowerCase() === 'x',
                verify: m[3].trim(),
                e2e: null
            });
        }
        if (!this.milestones.length) {
            MILESTONE_E2E_RE.lastIndex = 0;
            while ((m = MILESTONE_E2E_RE.exec(text)) !== null) {
                this.milestones.push({
                    id: m[2],
                    done: m[1].toLowerCase() === 'x',
                    verify: null,
                    e2e: m[3].trim()
                });
            }
        }
        if (!this.milestones.length) {
            MILESTONE_SIMPLE.lastIndex = 0;
            while ((m = MILESTONE_SIMPLE.exec(text)) !== null) {
                this.milestones.push({ id: m[2], done: m[1].toLowerCase() === 'x', verify: null, e2e: null });
            }
        }
        const firstOpen = this.milestones.findIndex(x => !x.done);
        this.milestoneIndex = firstOpen >= 0 ? firstOpen : Math.max(0, this.milestones.length - 1);
    }

    readPlanExcerpt(maxChars = 1200) {
        if (!this.enabled) return '';
        try {
            const text = fs.readFileSync(planPath(this.projectRoot), 'utf-8');
            return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n… (truncated)';
        } catch (e) {
            return '';
        }
    }

    readImplementTail(maxEntries = 3) {
        if (!this.enabled) return [];
        let text = '';
        try { text = fs.readFileSync(implementPath(this.projectRoot), 'utf-8'); } catch (e) { return []; }
        const blocks = text.split(/^### /m).slice(1);
        return blocks.slice(-maxEntries).map(b => '### ' + b.trim().slice(0, 400));
    }

    async appendImplementEntry({ title, what, decision, deviation, next }) {
        if (!this.enabled) return;
        const now = new Date();
        const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
        const lines = [
            `### ${stamp} — ${title || 'Update'}`,
            '',
            '**What happened:**',
            what || '(tool activity)',
            ''
        ];
        if (decision) {
            lines.push('**Decision:**', decision, '');
        }
        if (deviation) {
            lines.push('**Deviation from plan:**', deviation, '');
        }
        if (next) {
            lines.push('**Next:**', next, '');
        }
        lines.push('---', '');

        const p = implementPath(this.projectRoot);
        let existing = '';
        try { existing = await fsPromises.readFile(p, 'utf-8'); } catch (e) { /* new */ }
        const marker = '<!-- Add new entries above this line. Oldest entries at the bottom. -->';
        if (existing.includes(marker)) {
            existing = existing.replace(marker, lines.join('\n') + marker);
        } else {
            existing = (existing.trim() + '\n\n' + lines.join('\n')).trim() + '\n';
        }
        await fsPromises.writeFile(p, existing, 'utf-8');
    }

    async markMilestoneDone(milestoneId) {
        if (!this.enabled) return false;
        const id = milestoneId || (this.milestones[this.milestoneIndex]?.id);
        if (!id) return false;

        let text = fs.readFileSync(planPath(this.projectRoot), 'utf-8');
        const re = new RegExp(`(-\\s*\\[\\s*\\]\\s*\\*\\*${id}[^*]*\\*\\*)`, 'i');
        if (!re.test(text)) return false;
        text = text.replace(re, (line) => line.replace('[ ]', '[x]'));
        await fsPromises.writeFile(planPath(this.projectRoot), text, 'utf-8');
        this.reloadMilestones();
        return true;
    }

    activeMilestone() {
        if (!this.enabled || !this.milestones.length) return null;
        return this.milestones[this.milestoneIndex] || null;
    }

    activeVerifyCommand() {
        const m = this.activeMilestone();
        return m?.verify || null;
    }

    toContextBlock() {
        if (!this.enabled) return '';
        const lines = ['[PLAN ARTIFACTS]', `Files: ${ARTIFACT_DIR}/${PLAN_FILE}, ${ARTIFACT_DIR}/${IMPLEMENT_FILE}`];
        const active = this.activeMilestone();
        if (active) {
            lines.push(`Active milestone: ${active.id}${active.done ? ' (done)' : ''}`);
            if (active.verify) lines.push(`Verify when ready: ${active.verify}`);
            if (active.e2e) lines.push(`E2E when ready: ${active.e2e}`);
        }
        const excerpt = this.readPlanExcerpt(800);
        if (excerpt) {
            lines.push('', 'PLAN excerpt:', excerpt);
        }
        const tail = this.readImplementTail(2);
        if (tail.length) {
            lines.push('', 'Recent IMPLEMENT log:');
            tail.forEach(t => lines.push(t.slice(0, 300)));
        }
        return lines.join('\n');
    }

    serialize() {
        return {
            enabled: this.enabled,
            milestoneIndex: this.milestoneIndex,
            milestones: this.milestones
        };
    }

    restore(data) {
        if (!data) return;
        this.enabled = !!data.enabled;
        this.milestoneIndex = data.milestoneIndex || 0;
        this.milestones = data.milestones || [];
        if (this.enabled) this.reloadMilestones();
    }
}

module.exports = {
    PlanArtifacts,
    ARTIFACT_DIR,
    isNonTrivialTask,
    planPath,
    implementPath
};
