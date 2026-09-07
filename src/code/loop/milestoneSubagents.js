/**
 * Milestone subagent orchestrator — v1 shared root, v2 worktree per milestone.
 */
'use strict';

const {
    createMilestoneWorktree,
    cleanupMilestoneWorktree,
    syncWorktreeFiles,
    childSessionId,
    gitOk
} = require('../../main/services/worktreeManager.js');
const { checkCompletion } = require('../governor/completionGate.js');

function resolveSubagentMode(session) {
    if (!session.parallelMilestones) return null;
    if (session.milestoneWorktrees) {
        return session.milestoneConcurrent ? 'worktree-concurrent' : 'worktree-sequential';
    }
    return 'shared-sequential';
}

function openMilestones(planArtifacts) {
    if (!planArtifacts?.enabled) return [];
    return (planArtifacts.milestones || []).filter(m => !m.done);
}

function shouldUseSubagents(session, planArtifacts) {
    return session.parallelMilestones
        && planArtifacts?.enabled
        && (planArtifacts.milestones?.length || 0) >= 3;
}

async function runOneMilestone(opts, milestone) {
    const {
        session, parentProjectRoot, planAnchor, planArtifacts, earlyStop, qualityMonitor,
        trace, userDataPath, buildExecDeps, execDeps, emit, signal, apiBaseUrl, apiKey,
        pluginToolSchemas, pluginToolNames, streamCompletion, memory, pluginManager,
        executeTurnLoop, projectContext, mode
    } = opts;

    const useWorktree = mode.startsWith('worktree');
    let worktreePath = null;
    let worktreeBranch = null;
    const childId = useWorktree ? childSessionId(session.id, milestone.id) : session.id;

    if (useWorktree) {
        const wt = createMilestoneWorktree(parentProjectRoot, session.id, milestone.id);
        if (wt.error) {
            emit({
                type: 'subagent_error',
                milestoneId: milestone.id,
                error: wt.error,
                mode: 'worktree'
            });
            return { ok: false, files: [], error: wt.error };
        }
        worktreePath = wt.path;
        worktreeBranch = wt.branch;
    }

    emit({
        type: 'subagent_start',
        milestoneId: milestone.id,
        worktreePath,
        branch: worktreeBranch,
        mode: useWorktree ? 'worktree' : 'shared',
        childSessionId: childId
    });

    const prevRoot = projectContext.getRoot();
    if (useWorktree && worktreePath) {
        projectContext.setRoot(worktreePath);
    }

    const childSession = Object.assign({}, session, {
        id: childId,
        isolatedRun: false,
        worktreePath: null,
        parallelMilestones: false,
        milestoneWorktrees: false,
        milestoneConcurrent: false,
        messages: [{
            role: 'user',
            content: `[MILESTONE ${milestone.id}]\n${milestone.verify || milestone.e2e || 'Complete this milestone.'}\n\nParent task: ${session.goal}`
        }],
        turn: 0,
        toolCount: 0,
        phase: 'implement',
        filesTouched: [],
        projectRoot: useWorktree ? worktreePath : session.projectRoot,
        parentProjectRoot: parentProjectRoot
    });

    try {
        await executeTurnLoop({
            session: childSession,
            planAnchor,
            planArtifacts,
            earlyStop,
            qualityMonitor,
            trace,
            userDataPath,
            buildExecDeps,
            execDeps,
            emit,
            signal,
            apiBaseUrl,
            apiKey: apiKey || null,
            pluginToolSchemas,
            pluginToolNames,
            streamCompletion,
            memory,
            pluginManager,
            projectRoot: parentProjectRoot
        });
    } finally {
        if (useWorktree && worktreePath) {
            projectContext.setRoot(prevRoot);
        }
    }

    let files = childSession.filesTouched || [];
    if (useWorktree && worktreePath && files.length) {
        const sync = syncWorktreeFiles(parentProjectRoot, worktreePath, files);
        files = sync.synced;
        if (sync.errors.length) {
            emit({ type: 'subagent_sync_warning', milestoneId: milestone.id, errors: sync.errors });
        }
        cleanupMilestoneWorktree(parentProjectRoot, session.id, milestone.id);
    }

    emit({
        type: 'subagent_done',
        milestoneId: milestone.id,
        files,
        worktreePath,
        mode: useWorktree ? 'worktree' : 'shared'
    });

    return { ok: true, files };
}

async function runMilestoneSubagentOrchestrator(opts) {
    const {
        session, planArtifacts, parentProjectRoot, emit, executeTurnLoop, projectContext
    } = opts;

    const mode = resolveSubagentMode(session);
    if (!mode) return { handled: false };

    if (mode.startsWith('worktree') && !gitOk(parentProjectRoot)) {
        emit({
            type: 'error',
            message: 'MILESTONE WORKTREES requires a git repository. Disabling worktree isolation for this run.'
        });
        session.milestoneWorktrees = false;
    }

    const effectiveMode = resolveSubagentMode(session);
    const milestones = openMilestones(planArtifacts);
    const mergedFiles = [...(session.filesTouched || [])];

    const runOpts = Object.assign({}, opts, { mode: effectiveMode, executeTurnLoop, projectContext });

    if (effectiveMode === 'worktree-concurrent' && milestones.length > 1) {
        const results = await Promise.all(milestones.map(m => runOneMilestone(runOpts, m)));
        for (const r of results) {
            if (r.ok) {
                for (const f of r.files) {
                    if (!mergedFiles.includes(f)) mergedFiles.push(f);
                }
            }
        }
    } else {
        for (const milestone of milestones) {
            const r = await runOneMilestone(runOpts, milestone);
            if (r.ok) {
                for (const f of r.files) {
                    if (!mergedFiles.includes(f)) mergedFiles.push(f);
                }
            }
        }
    }

    session.filesTouched = mergedFiles;

    const finalGate = await checkCompletion(
        parentProjectRoot,
        session.filesTouched,
        session.goal,
        {
            grindMode: session.grindMode,
            projectMeta: session.projectMeta,
            planArtifacts
        }
    );

    return {
        handled: true,
        finalGate,
        mode: effectiveMode
    };
}

module.exports = {
    resolveSubagentMode,
    shouldUseSubagents,
    openMilestones,
    runMilestoneSubagentOrchestrator,
    childSessionId
};
