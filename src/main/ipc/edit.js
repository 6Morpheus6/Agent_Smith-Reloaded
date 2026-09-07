/**
 * IPC domain: targeted edits (search/replace, patch, batch).
 *
 * Registered via registerEditIpc(ipcMain, deps) where deps provides:
 *   editEngine, planStore, projectContext, relPathFromRoot, invalidateRepoMap,
 *   state (shared mutable { currentPlanId }).
 *
 * Handler bodies are unchanged from the original inline main.js definitions;
 * the only edit is `currentPlanId` -> `state.currentPlanId`.
 */
module.exports = function registerEditIpc(ipcMain, deps) {
    const { editEngine, planStore, projectContext, relPathFromRoot, invalidateRepoMap, state } = deps;

    ipcMain.handle('edit-apply', async (event, { planId, filepath, find, replace }) => {
        const pid = planId || state.currentPlanId;
        if (!pid) return { error: 'No active plan for edit' };
        const result = await editEngine.apply(pid, filepath, find, replace);
        if (result.success) {
            invalidateRepoMap();
            result.relPath = relPathFromRoot(result.path);
            if (planStore) {
                try {
                    const plan = await planStore.load(pid);
                    if (!plan.error) {
                        planStore.recordFileTouch(plan, result.relPath, 'edit');
                        if (plan.projectRoot !== projectContext.getRootOrNull()) {
                            plan.projectRoot = projectContext.getRootOrNull();
                        }
                        await planStore.save(plan);
                    }
                } catch (e) { /* non-fatal */ }
            }
        }
        return result;
    });

    ipcMain.handle('edit-apply-patch', async (event, { planId, filepath, patch }) => {
        const pid = planId || state.currentPlanId;
        if (!pid) return { error: 'No active plan' };
        const result = await editEngine.applyPatch(pid, filepath, patch);
        if (result.success) {
            invalidateRepoMap();
            result.relPath = relPathFromRoot(result.path);
            const plan = await planStore.load(pid);
            if (!plan.error) {
                planStore.recordFileTouch(plan, result.relPath, 'edit');
                await planStore.save(plan);
            }
        }
        return result;
    });

    ipcMain.handle('edit-apply-batch', async (event, { planId, edits }) => {
        const pid = planId || state.currentPlanId;
        if (!pid) return { error: 'No active plan' };
        const res = await editEngine.applyBatch(pid, edits || []);
        invalidateRepoMap();
        if (res.results) {
            let plan = null;
            try { const p = await planStore.load(pid); if (!p.error) plan = p; } catch (e) { plan = null; }
            for (const r of res.results) {
                if (r.result?.success && r.result.path) {
                    r.result.relPath = relPathFromRoot(r.result.path);
                    if (plan) planStore.recordFileTouch(plan, r.result.relPath, 'edit');
                }
            }
            if (plan) { try { await planStore.save(plan); } catch (e) { /* non-fatal */ } }
        }
        return res;
    });
};
