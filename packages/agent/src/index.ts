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

// The ACP (Agent Client Protocol) surface: the stdio starter both ACP bins run, the
// version-dispatching connector behind it, and each dialect's app for serving one on its own.
export { startAcpServer } from '#src/modules/acp/acpStdio.js';
export { createAcpAgentRouter } from '#src/modules/acp/acpRouter.js';
export { createAcpAgentApp } from '#src/modules/acp/acpAgentApp.js';
export { createAcpV1AgentApp } from '#src/modules/acp/acpAgentAppV1.js';
