/**
 * Example hook: log every tool call before it runs. before* hooks may veto by
 * returning { block: true, reason }. This one only observes.
 */
module.exports = {
    event: 'beforeToolCall',
    async run(payload, host) {
        host.log(`about to run tool: ${payload.toolName}`);
    },
};
