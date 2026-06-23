/**
 * @module tools/shell/normalize
 *
 * Re-export of the canonical command normalizer, which now lives in
 * `@gaunt-sloth/core` (`core/shell/normalize`) so the core runner's EXT-9 Tier-2
 * allow-list classifier and the agent's Tier-1 hardline blocklist share ONE
 * implementation. Kept as a stable import path for existing agent-side consumers
 * (`tools/shell/hardline`, specs).
 */
export { normalizeCommand } from '@gaunt-sloth/core/core/shell/normalize.js';
