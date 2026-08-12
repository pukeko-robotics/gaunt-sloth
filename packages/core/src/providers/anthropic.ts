import { displayWarning } from '#src/utils/consoleUtils.js';
import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';
import {
  NATIVE_CLIENT_REASON,
  warnUnusedConfiguration,
} from '#src/providers/configurationPassthrough.js';
import { env } from '#src/utils/systemUtils.js';
import type { AnthropicInput } from '@langchain/anthropic';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';

/**
 * Function to process JSON config and create Anthropic LLM instance
 */
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: AnthropicInput & BaseChatModelParams
): Promise<BaseChatModel> {
  const anthropic = await import('@langchain/anthropic');
  // Use config value if available, otherwise use the environment variable
  const anthropicApiKey = llmConfig.apiKey || env.ANTHROPIC_API_KEY;
  // `ChatAnthropic` builds an Anthropic SDK client from its own `clientOptions`, so nothing in a
  // `configuration` block reaches it — say so before dropping it.
  warnUnusedConfiguration({
    provider: 'anthropic',
    configuration: (llmConfig as { configuration?: unknown }).configuration,
    consumedPaths: [],
    reason: NATIVE_CLIENT_REASON,
    guidance:
      'ChatAnthropic builds an Anthropic SDK client instead: put client options such as a custom ' +
      'base URL, a timeout or extra headers under "clientOptions" in the "llm" block, or set ' +
      '"anthropicApiUrl" there for the base URL alone.',
  });
  return new anthropic.ChatAnthropic({
    ...llmConfig,
    apiKey: anthropicApiKey,
    model: llmConfig.model || getCuratedFallbackModel('anthropic'),
  });
}

// noinspection JSUnusedGlobalSymbols
export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('anthropic', model), force);
  displayWarning(
    `You need to update your ${configFileName} to add your Anthropic API key, ` +
      'or define ANTHROPIC_API_KEY environment variable.'
  );
}
