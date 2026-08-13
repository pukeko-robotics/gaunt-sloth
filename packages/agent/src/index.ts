export * from '#src/modules/apiAgUiModule.js';
export * from '#src/modules/interactiveSessionModule.js';
export * from '#src/modules/a2a/A2AClientWrapper.js';
export * from '#src/tools/A2AAgentTool.js';
export * from '#src/mcp/OAuthClientProviderImpl.js';
export * from '#src/utils/mcpUtils.js';
export { createResolvers } from '#src/resolvers.js';

// Tools + middleware (formerly @gaunt-sloth/tools)
export * from '#src/builtInToolsConfig.js';
export { resolveMiddleware } from '#src/middleware/registry.js';

// The agent-backend seam every command resolves its factory through.
export { resolveAgentFactory } from '#src/core/resolveAgentFactory.js';

// The ACP (Agent Client Protocol) v2 agent, and the stdio starter both ACP bins run.
export { startAcpServer } from '#src/modules/acp/acpStdio.js';
export { createAcpAgentApp } from '#src/modules/acp/acpAgentApp.js';
