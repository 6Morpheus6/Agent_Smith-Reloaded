/**
 * Example project rule — copy to .agentsmith/rules/no-console-in-src.js in your project.
 */
'use strict';

module.exports = {
    id: 'no-console-in-src',
    match(relPath) {
        return /^src[/\\]/.test(relPath) && /\.(js|mjs|cjs|ts|tsx)$/.test(relPath);
    },
    async check(ctx) {
        if (/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(ctx.content)) {
            return {
                ok: false,
                message: `${ctx.relPath} contains console.* calls — remove or replace with structured logging.`,
                fix: `Remove console.* from ${ctx.relPath} or use a logger module.`
            };
        }
        return { ok: true };
    }
};
