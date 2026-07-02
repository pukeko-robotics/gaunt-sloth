import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { ChatDeepSeekInput } from '@langchain/deepseek';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';

// Function to process JSON config and create DeepSeek LLM instance
export async function processJsonConfig(
  llmConfig: ChatDeepSeekInput & BaseChatModelParams
): Promise<BaseChatModel> {
  const deepseek = await import('@langchain/deepseek');
  // Use config apiKey if available, otherwise use the environment variable
  const deepseekApiKey = llmConfig.apiKey || env.DEEPSEEK_API_KEY;
  return new deepseek.ChatDeepSeek({
    ...llmConfig,
    apiKey: deepseekApiKey,
    model: llmConfig.model || getCuratedFallbackModel('deepseek'),
  });
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('deepseek', model), force);
  displayWarning(
    `You need to update your ${configFileName} to add your DeepSeek API key, ` +
      'or define DEEPSEEK_API_KEY environment variable.'
  );
}
