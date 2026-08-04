import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import type { ChatOpenRouterInput } from '@langchain/openrouter';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';

// Function to process JSON config and create OpenRouter LLM instance
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: ChatOpenRouterInput & BaseChatModelParams & Record<string, unknown>
): Promise<BaseChatModel> {
  const { ChatOpenRouter } = await import('@langchain/openrouter');

  const openRouterApiKey = getApiKey(llmConfig);
  if (!openRouterApiKey) {
    throw new Error(
      'You need to define OPEN_ROUTER_API_KEY environment variable, or set apiKey in your config file.'
    );
  }

  const {
    type: _type,
    apiKeyEnvironmentVariable: _envVar,
    configuration,
    siteUrl,
    siteName,
    ...restConfig
  } = llmConfig;

  const configObj = configuration as
    { baseURL?: string; defaultHeaders?: Record<string, string> } | undefined;

  const resolvedSiteUrl =
    siteUrl ?? configObj?.defaultHeaders?.['HTTP-Referer'] ?? 'https://gauntsloth.app/';
  const resolvedSiteName = siteName ?? configObj?.defaultHeaders?.['X-Title'] ?? 'Gaunt Sloth';

  return new ChatOpenRouter({
    ...restConfig,
    apiKey: openRouterApiKey,
    model: llmConfig.model || getCuratedFallbackModel('openrouter'),
    siteUrl: resolvedSiteUrl,
    siteName: resolvedSiteName,
    ...(configObj?.baseURL ? { baseURL: configObj.baseURL } : {}),
  });
}

function getApiKey(llmConfig: Record<string, unknown>): string | undefined {
  const envVarName = llmConfig.apiKeyEnvironmentVariable as string | undefined;
  if (envVarName && env[envVarName]) {
    return env[envVarName];
  }
  return (
    (llmConfig.apiKey as string | undefined) || env.OPEN_ROUTER_API_KEY || env.OPENROUTER_API_KEY
  );
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('openrouter', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure model, ` +
      'or define OPEN_ROUTER_API_KEY environment variable.'
  );
}
