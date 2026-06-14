export * from '#src/modules/apiAgUiModule.js';
export * from '#src/modules/acpModule.js';
export * from '#src/modules/interactiveSessionModule.js';
export * from '#src/modules/a2a/A2AClientWrapper.js';
export * from '#src/tools/A2AAgentTool.js';
export * from '#src/mcp/OAuthClientProviderImpl.js';
export * from '#src/utils/mcpUtils.js';
export { createResolvers } from '#src/resolvers.js';

// Tools + middleware (formerly @gaunt-sloth/tools)
export * from '#src/builtInToolsConfig.js';
export { resolveMiddleware } from '#src/middleware/registry.js';

// Deep agent (createDeepAgent / deepagents) + the GthConfig→permission mapping
export { GthDeepAgent, type GthDeepAgentParams } from '#src/core/GthDeepAgent.js';
export * from '#src/core/deepAgentPermissions.js';
export { gthDeepAgentFactory } from '#src/core/gthDeepAgentFactory.js';
