import type { GthAgentFactory } from '@gaunt-sloth/core/core/types.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { GthDeepAgent } from '#src/core/GthDeepAgent.js';

/**
 * A {@link GthAgentFactory} that produces a {@link GthDeepAgent}. Pass this to
 * `GthAgentRunner` (its optional 3rd ctor arg) so the same runner drives a
 * `createDeepAgent` graph instead of the lean default — without `core` ever
 * importing `deepagents`.
 *
 * The deepagents backend is **experimental**: lean is the default. Selecting it (via
 * `agent.backend: 'deep'`) emits a one-time warning so it is never used unknowingly.
 */
export const gthDeepAgentFactory: GthAgentFactory = (statusUpdate, resolvers) => {
  statusUpdate(
    StatusLevel.WARNING,
    'Using the experimental deepagents backend (agent.backend: deep). The lean agent is the ' +
      'default and recommended backend; deep may exhibit path-divergence or sporadic failures.'
  );
  return new GthDeepAgent(statusUpdate, resolvers);
};
