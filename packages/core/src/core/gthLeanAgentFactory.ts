import type { GthAgentFactory } from '#src/core/types.js';
import { GthLangChainAgent } from '#src/core/GthLangChainAgent.js';

/**
 * The lean backend factory — a {@link GthAgentFactory} that produces a plain
 * {@link GthLangChainAgent} (no deepagents graph). This is identical to the built-in
 * default {@link GthAgentRunner} constructs when no factory is passed; exporting it lets
 * `@gaunt-sloth/agent`'s {@link resolveAgentFactory} pick lean vs deep from config without
 * duplicating the constructor call.
 */
export const gthLeanAgentFactory: GthAgentFactory = (statusUpdate, resolvers) =>
  new GthLangChainAgent(statusUpdate, resolvers);
