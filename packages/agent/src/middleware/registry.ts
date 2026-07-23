/**
 * @packageDocumentation
 * Middleware registry for Gaunt Sloth.
 *
 * This module provides factory functions for creating predefined middleware instances
 * and a resolver to convert middleware configurations into middleware objects.
 */

import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type {
  AnthropicPromptCachingConfig,
  MiddlewareConfig,
  PredefinedMiddlewareConfig,
  SummarizationConfig,
} from '#src/middleware/types.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import {
  anthropicPromptCachingMiddleware,
  summarizationMiddleware,
  type AgentMiddleware,
} from 'langchain';
import {
  createBinaryContentInjectionMiddleware,
  type BinaryContentInjectionMiddlewareSettings,
} from '#src/middleware/binaryContentInjectionMiddleware.js';
import { createFrontendImageInjectionMiddleware } from '#src/middleware/frontendImageInjectionMiddleware.js';

type PredefinedMiddlewareFactory = (
  settings: Record<string, unknown>,
  gthConfig: GthConfig
) => Promise<AgentMiddleware>;

/**
 * Derive the provider string the vision middleware maps to a per-provider block shape. Prefers the
 * loader-stashed raw `llm.type` ({@link GthConfig.modelProviderType}) — the exact gth provider
 * namespace (`anthropic`/`openrouter`/`deepseek`/`xai`/`groq`/`ollama`/`google-genai`/`vertexai`/…)
 * — and falls back to the live model's `_llmType()` only when it is absent (module configs). The
 * OpenAI-compatible shims (openrouter/deepseek/xai/groq) all report `_llmType() === 'openai'`, which
 * maps to the same `image_url:{url}` block, so the fallback stays shape-correct.
 */
function resolveVisionProvider(gthConfig: GthConfig): string {
  if (gthConfig.modelProviderType) return gthConfig.modelProviderType;
  const llm = gthConfig.llm as { _llmType?: () => string } | undefined;
  try {
    if (typeof llm?._llmType === 'function') return llm._llmType();
  } catch {
    // A misbehaving _llmType must not break middleware resolution.
  }
  return '';
}

const predefinedMiddlewareFactories = {
  /**
   * Anthropic prompt caching middleware. see https://docs.langchain.com/oss/javascript/langchain/middleware#anthropic-prompt-caching
   */
  'anthropic-prompt-caching': (
    settings: Record<string, unknown>,
    gthConfig: GthConfig
  ): Promise<AgentMiddleware> =>
    createAnthropicPromptCachingMiddleware(settings as AnthropicPromptCachingConfig, gthConfig),
  /**
   * Summarization middleware. see https://docs.langchain.com/oss/javascript/langchain/middleware#summarization
   */
  summarization: (
    settings: Record<string, unknown>,
    gthConfig: GthConfig
  ): Promise<AgentMiddleware> =>
    createSummarizationMiddleware(settings as SummarizationConfig, gthConfig),
  /**
   * Binary content injection middleware.
   * Intercepts tool results containing binary data (images, PDFs, audio) and injects them
   * as HumanMessage content blocks before the next model call.
   * This works around LangChain's limitation where ToolMessage doesn't support binary content.
   */
  'binary-content-injection': (
    settings: Record<string, unknown>,
    gthConfig: GthConfig
  ): Promise<AgentMiddleware> =>
    createBinaryContentInjectionMiddleware(
      settings as BinaryContentInjectionMiddlewareSettings,
      gthConfig
    ),
  /**
   * Frontend image injection middleware (RC-22). Converts a frontend capture tool's
   * `{mimeType,data}` ToolMessage (default tool name `capture_image`) into a provider-appropriate
   * vision HumanMessage the model can see. Strictly opt-in — resolved ONLY when named in
   * `config.middleware` (no auto-inject branch). Optional `toolName` setting overrides the tool name.
   */
  'frontend-image-injection': (
    settings: Record<string, unknown>,
    gthConfig: GthConfig
  ): Promise<AgentMiddleware> =>
    Promise.resolve(
      createFrontendImageInjectionMiddleware({
        provider: resolveVisionProvider(gthConfig),
        toolName: typeof settings.toolName === 'string' ? settings.toolName : undefined,
      })
    ),
} satisfies Record<string, PredefinedMiddlewareFactory>;

function isPredefinedMiddlewareName(
  name: string
): name is keyof typeof predefinedMiddlewareFactories {
  return name in predefinedMiddlewareFactories;
}

function isPredefinedMiddlewareObject(
  config: MiddlewareConfig
): config is PredefinedMiddlewareConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'name' in config &&
    typeof (config as { name: unknown }).name === 'string' &&
    isPredefinedMiddlewareName((config as { name: string }).name)
  );
}

/**
 * Create Anthropic prompt caching middleware.
 * This middleware adds cache control headers to reduce API costs.
 */
export async function createAnthropicPromptCachingMiddleware(
  config: AnthropicPromptCachingConfig,
  _: GthConfig
): Promise<AgentMiddleware> {
  debugLog(`Creating Anthropic prompt caching middleware with TTL: ${config.ttl || 'default'}`);

  // Dynamic import for async initialization
  return Promise.resolve(anthropicPromptCachingMiddleware({ ttl: config.ttl }));
}

/**
 * Create summarization middleware.
 * This middleware automatically condenses conversation history when approaching token limits.
 *
 * @param config - Configuration for the middleware
 * @param gthConfig - Full Gaunt Sloth configuration
 * @returns Middleware object
 */
export async function createSummarizationMiddleware(
  config: SummarizationConfig,
  gthConfig: GthConfig
): Promise<AgentMiddleware> {
  debugLog('Creating summarization middleware');

  return Promise.resolve(
    summarizationMiddleware({
      model: config.model || gthConfig.llm,
      ...config,
    })
  );
}

/**
 * Resolve middleware configuration into middleware instances.
 * Converts string identifiers and config objects into actual middleware.
 * Automatically injects binary-content-injection middleware if binaryFormats is enabled.
 *
 * @param configs - Array of middleware configurations
 * @param gthConfig - Full Gaunt Sloth configuration
 * @returns Array of middleware instances
 */
export async function resolveMiddleware(
  configs: MiddlewareConfig[] | undefined,
  gthConfig: GthConfig
): Promise<AgentMiddleware[]> {
  const configsToResolve = configs || [];
  const middleware: AgentMiddleware[] = [];

  // Auto-inject binary-content-injection middleware if binaryFormats is configured
  // It is only auto-injected if binaryFormats is enabled.
  const hasBinaryFormats =
    gthConfig.binaryFormats !== undefined &&
    gthConfig.binaryFormats !== false &&
    gthConfig.binaryFormats.length > 0;
  const hasBinaryMiddleware = configsToResolve.some(
    (c) =>
      c === 'binary-content-injection' ||
      (typeof c === 'object' && 'name' in c && c.name === 'binary-content-injection')
  );

  if (hasBinaryFormats && !hasBinaryMiddleware) {
    debugLog('Auto-injecting binary-content-injection middleware (binaryFormats is enabled)');
    middleware.push(await createPredefinedMiddleware('binary-content-injection', {}, gthConfig));
  }

  for (const config of configsToResolve) {
    try {
      // Handle string configuration (predefined middleware with defaults)
      if (typeof config === 'string') {
        middleware.push(await createPredefinedMiddleware(config, {}, gthConfig));
      }
      // Handle predefined middleware with custom settings
      else if (isPredefinedMiddlewareObject(config)) {
        const { name, ...settings } = config;
        middleware.push(await createPredefinedMiddleware(name, settings, gthConfig));
      }
      // Handle custom middleware object (JS config only)
      else {
        debugLog('Adding custom middleware');
        middleware.push(config as AgentMiddleware);
      }
    } catch (error) {
      displayWarning(
        `Failed to create middleware: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return middleware;
}

/**
 * Create a predefined middleware instance by name.
 *
 * @param name - Name of the predefined middleware
 * @param settings - Configuration settings for the middleware
 * @param gthConfig - Full Gaunt Sloth configuration
 * @returns Middleware instance
 */
async function createPredefinedMiddleware(
  name: string,
  settings: Record<string, unknown>,
  gthConfig: GthConfig
): Promise<AgentMiddleware> {
  if (!isPredefinedMiddlewareName(name)) {
    throw new Error(`Unknown predefined middleware: ${name}`);
  }

  const factory = predefinedMiddlewareFactories[name];
  return factory(settings, gthConfig);
}
