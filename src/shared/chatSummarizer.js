/**
 * Deterministic, synchronous digest of messages about to be evicted for budget. Avoids
 * silent context loss without needing an extra LLM call: records how many turns were
 * dropped, which files were already touched, and points at the durable plan artifacts.
 */
function digestDropped(messages) {
    const dropped = (messages || []).filter(Boolean);
    if (!dropped.length) return '';
    const files = new Set();
    for (const m of dropped) {
        if (m.role === 'tool') {
            const mm = String(m.content || '').match(/"relPath":\s*"([^"]+)"/);
            if (mm) files.add(mm[1]);
        }
    }
    const parts = [`[CONTEXT COMPACTED] ${dropped.length} earlier message(s) elided to fit the window`];
    if (files.size) parts.push(`files already touched: ${[...files].slice(0, 12).join(', ')}`);
    parts.push('full history persists in .agentsmith/PLAN.md + IMPLEMENT.md — read them if you need it');
    return parts.join('; ') + '.';
}

module.exports = { digestDropped };
