/**
 * @module tools/shell/arity
 *
 * Re-export of the EXT-9 Tier-2 command classifier. The implementation lives in
 * `@gaunt-sloth/core` (`core/shell/arity`) because the core {@link GthAgentRunner}
 * must consult it BEFORE prompting (and core cannot import from `@gaunt-sloth/agent`).
 * This stable agent-side path is kept for tests and any agent-layer consumers.
 *
 * See the core module for the arity table scope and the anti-injection fail-closed rule.
 */
export {
  classifyCommand,
  tokenize,
  meaningfulPrefixTokens,
  type CommandClassification,
} from '@gaunt-sloth/core/core/shell/arity.js';
