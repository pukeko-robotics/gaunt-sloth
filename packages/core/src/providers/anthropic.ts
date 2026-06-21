import { displayWarning } from '#src/utils/consoleUtils.js';
import { writeFileIfNotExistsWithMessages } from '#src/utils/fileUtils.js';
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
  return new anthropic.ChatAnthropic({
    ...llmConfig,
    apiKey: anthropicApiKey,
    model: llmConfig.model || 'claude-sonnet-4-6',
  });
}

const jsonContent = `{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-6"
  }
}`;

// noinspection JSUnusedGlobalSymbols
export function init(configFileName: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeFileIfNotExistsWithMessages(configFileName, jsonContent);
  displayWarning(
    `You need to update your ${configFileName} to add your Anthropic API key, ` +
      'or define ANTHROPIC_API_KEY environment variable.'
  );
}
