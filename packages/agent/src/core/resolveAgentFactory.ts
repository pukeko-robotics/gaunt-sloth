import type { GthAgentFactory } from '@gaunt-sloth/core/core/types.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { gthLeanAgentFactory } from '@gaunt-sloth/core/core/gthLeanAgentFactory.js';
import { gthDeepAgentFactory } from '#src/core/gthDeepAgentFactory.js';

/**
 * Resolve the agent backend factory from config (B5). An explicit `agent.backend` wins;
 * otherwise `defaultBackend` is used — the per-command default:
 *   - `'deep'` for the interactive `code`/`chat` sessions,
 *   - `'lean'` for the single-shot `ask`/`exec` commands.
 *
 * Returns {@link gthDeepAgentFactory} for `'deep'` and {@link gthLeanAgentFactory} for `'lean'`.
 * Both factories receive the SAME `createResolvers()` toolset, so lean is not capability-stripped:
 * it keeps gaunt-sloth's own filesystem + (in code mode) dev/shell tools; it only drops the
 * deepagents-specific extras (subagent `task`, todos, summarization, `/large_tool_results`).
 */
export function resolveAgentFactory(
  config: GthConfig,
  defaultBackend: 'deep' | 'lean'
): GthAgentFactory {
  const backend = config.agent?.backend ?? defaultBackend;
  return backend === 'deep' ? gthDeepAgentFactory : gthLeanAgentFactory;
}
