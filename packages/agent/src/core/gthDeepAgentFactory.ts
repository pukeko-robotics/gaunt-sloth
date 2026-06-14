import type { GthAgentFactory } from '@gaunt-sloth/core/core/types.js';
import { GthDeepAgent } from '#src/core/GthDeepAgent.js';

/**
 * A {@link GthAgentFactory} that produces a {@link GthDeepAgent}. Pass this to
 * `GthAgentRunner` (its optional 3rd ctor arg) so the same runner drives a
 * `createDeepAgent` graph instead of the lean default — without `core` ever
 * importing `deepagents`.
 */
export const gthDeepAgentFactory: GthAgentFactory = (statusUpdate, resolvers) =>
  new GthDeepAgent(statusUpdate, resolvers);
