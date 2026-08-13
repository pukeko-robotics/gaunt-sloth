import type { GthAgentFactory } from '@gaunt-sloth/core/core/types.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { gthLeanAgentFactory } from '@gaunt-sloth/core/core/gthLeanAgentFactory.js';

/**
 * Resolve the agent backend factory from config (B5).
 *
 * There is one backend — the lean {@link gthLeanAgentFactory} — so every call resolves to it, and
 * `agent.backend` can only name it. The seam is kept rather than inlined at the ten call sites
 * because it is the single place a backend choice is made: reinstating a choice (EXT-46's ACP
 * rebuild, or any later runtime) is an edit here, not an edit spread across every command.
 *
 * The parameters are accepted and ignored for the same reason. `defaultBackend` is each caller's
 * per-command default, and every caller passes `'lean'`; typing it as the literal keeps a caller
 * that means something else from compiling silently.
 */
export function resolveAgentFactory(
  _config: GthConfig,
  _defaultBackend: 'lean' = 'lean'
): GthAgentFactory {
  return gthLeanAgentFactory;
}
