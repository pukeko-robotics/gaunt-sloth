import type { GthAgentFactory } from '#src/core/types.js';
import { GthLangChainAgent } from '#src/core/GthLangChainAgent.js';

/**
 * The lean backend factory — a {@link GthAgentFactory} that produces a plain
 * {@link GthLangChainAgent}. This is identical to the built-in default {@link GthAgentRunner}
 * constructs when no factory is passed; exporting it lets `@gaunt-sloth/agent`'s
 * {@link resolveAgentFactory} hand the runner a backend without duplicating the constructor
 * call.
 */
export const gthLeanAgentFactory: GthAgentFactory = (statusUpdate, resolvers) =>
  new GthLangChainAgent(statusUpdate, resolvers);
