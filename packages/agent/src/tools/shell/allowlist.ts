/**
 * @module tools/shell/allowlist
 *
 * Re-export of the EXT-9 Tier-2 allow-list engine. The implementation lives in
 * `@gaunt-sloth/core` (`core/shell/allowlist`) because the core {@link GthAgentRunner}
 * owns the per-instance session store and the loaded persisted store and consults
 * `matchesApproval` before prompting (core cannot import from `@gaunt-sloth/agent`).
 *
 * See the core module for the exact safe-bin / anti-widening matching rule.
 */
export {
  matchesApproval,
  hasWideningFlag,
  AllowlistStore,
  PersistedAllowlist,
  type ApprovalScope,
  type ApprovalStores,
} from '@gaunt-sloth/core/core/shell/allowlist.js';
