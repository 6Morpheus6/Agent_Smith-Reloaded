/**
 * Code session state — conversation history + run metadata (replaces plan JSON).
 */
'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const _saveTimers = new Map();

class CodeSession {
    constructor(id, opts = {}) {
        this.id = id;
        this.goal = opts.goal || '';
        this.projectRoot = opts.projectRoot || '';
        this.model = opts.model || '';
        this.numCtx = opts.numCtx || 8192;
        this.codeTemperature = opts.codeTemperature ?? 0.2;
        this.status = 'idle';
        this.turn = 0;
        this.toolCount = 0;
        this.messages = [];
        this.filesTouched = [];
        // v51.5 TEST BEFORE DONE — true when a verification command (test/lint/compile) exited 0
        // after the most recent edit; reset to false on every successful write. The beforeDone
        // middleware vetoes completion while it is false, so "done" always means "verified".
        this.testRunsSinceEdit = false;
        this.completionReflections = 0;
        this.startedAt = Date.now();
        this.finishedAt = null;
        this.error = null;
        this.phase = opts.phase || 'explore';
        this.milestoneIndex = opts.milestoneIndex || 0;
        this.validation = opts.validation || null;
        this.planAnchorState = opts.planAnchorState || null;
        this.planArtifactsState = opts.planArtifactsState || null;
        this.runId = opts.runId || null;
    }

    static sessionDir(userDataPath) {
        return path.join(userDataPath, 'code-sessions');
    }

    static toJSON(session) {
        return {
            id: session.id,
            goal: session.goal,
            projectRoot: session.projectRoot,
            model: session.model,
            numCtx: session.numCtx,
            codeTemperature: session.codeTemperature ?? 0.2,
            status: session.status,
            turn: session.turn,
            toolCount: session.toolCount,
            filesTouched: session.filesTouched || [],
            messages: (session.messages || []).slice(-80),
            startedAt: session.startedAt,
            finishedAt: session.finishedAt,
            error: session.error,
            phase: session.phase,
            milestoneIndex: session.milestoneIndex,
            validation: session.validation,
            completionReflections: session.completionReflections,
            planAnchorState: session.planAnchorState,
            planArtifactsState: session.planArtifactsState,
            runId: session.runId,
            codePlan: session.codePlan || null,
            workflow: session.workflow || null,
            // isolation fields — so a resumed isolated run can still find and clean up its worktree
            isolatedRun: session.isolatedRun || false,
            worktreePath: session.worktreePath || null,
            parentProjectRoot: session.parentProjectRoot || null,
            updatedAt: Date.now()
        };
    }

    static async save(userDataPath, session) {
        const dir = CodeSession.sessionDir(userDataPath);
        await fsPromises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${session.id}.json`);
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fsPromises.writeFile(temp, JSON.stringify(CodeSession.toJSON(session), null, 2), 'utf-8');
        await fsPromises.rename(temp, file);
    }

    static saveDebounced(userDataPath, session, ms = 500) {
        const key = session.id;
        if (_saveTimers.has(key)) clearTimeout(_saveTimers.get(key));
        _saveTimers.set(key, setTimeout(() => {
            _saveTimers.delete(key);
            CodeSession.save(userDataPath, session).catch(() => {});
        }, ms));
    }

    static async load(userDataPath, id) {
        const file = path.join(CodeSession.sessionDir(userDataPath), `${id}.json`);
        if (!fs.existsSync(file)) return null;
        const raw = await fsPromises.readFile(file, 'utf-8');
        const data = JSON.parse(raw);
        const s = new CodeSession(data.id, data);
        Object.assign(s, data);
        s.messages = data.messages || [];
        s.codePlan = data.codePlan || null;
        s.workflow = data.workflow || null;
        return s;
    }

    // v53.4 — fresh-start sweep: any persisted session still marked 'running' (or another
    // open state) was left that way by a PREVIOUS app process (quit mid-run, crash). On
    // every launch those sessions resurfaced as "Resume Code run?" candidates and their
    // goal text kept old tasks alive — small local models re-ran yesterday's task before
    // answering today's message. A previous process can never resume them anyway
    // (activeRun is in-memory), so close them at startup: status 'aborted' with an honest
    // reason. Files stay on disk for the ledger/history; only resumability ends.
    // EXCEPTION: 'awaiting_approval' survives — cross-restart plan review is an
    // intentional feature (the banner offers "Review plan" for it). Returns how many
    // sessions were closed.
    static sweepStale(userDataPath) {
        const dir = CodeSession.sessionDir(userDataPath);
        if (!fs.existsSync(dir)) return 0;
        const keepOpen = new Set(['done', 'incomplete', 'unverified', 'error', 'aborted', 'awaiting_approval']);
        let closed = 0;
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
            const fp = path.join(dir, f);
            try {
                const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                if (!raw || typeof raw !== 'object' || keepOpen.has(raw.status)) continue;
                raw.status = 'aborted';
                raw.error = 'Closed at app start — the run belonged to a previous session.';
                raw.updatedAt = Date.now();
                fs.writeFileSync(fp, JSON.stringify(raw, null, 2), 'utf-8');
                closed++;
            } catch (e) { /* corrupt file — leave alone */ }
        }
        return closed;
    }

    static async listIncomplete(userDataPath, projectRoot) {
        const dir = CodeSession.sessionDir(userDataPath);
        if (!fs.existsSync(dir)) return [];
        const terminal = new Set(['done', 'incomplete', 'unverified', 'error', 'aborted']);
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const out = [];
        for (const f of files) {
            try {
                const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
                if (terminal.has(raw.status)) continue;
                if (projectRoot && raw.projectRoot && raw.projectRoot !== projectRoot) continue;
                out.push({
                    id: raw.id,
                    goal: raw.goal,
                    turn: raw.turn,
                    startedAt: raw.startedAt,
                    projectRoot: raw.projectRoot,
                    status: raw.status
                });
            } catch (e) { /* skip corrupt */ }
        }
        return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    }
}

module.exports = { CodeSession };
