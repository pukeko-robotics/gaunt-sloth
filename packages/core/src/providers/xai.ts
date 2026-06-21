import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import type { ChatXAIInput } from '@langchain/xai';

import { writeFileIfNotExistsWithMessages } from '#src/utils/fileUtils.js';

// Function to process JSON config and create XAI LLM instance
export async function processJsonConfig(
  llmConfig: ChatXAIInput & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatXAI } = await import('@langchain/xai');
  // Use config value if available, otherwise use the environment variable
  const apiKey = llmConfig.apiKey || env.XAI_API_KEY;
  return new ChatXAI({
    ...llmConfig,
    apiKey,
    model: llmConfig.model || 'grok-4.3',
  });
}

const jsonContent = `{
  "llm": {
    "type": "xai",
    "model": "grok-4.3"
  }
}`;

export function init(configFileName: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeFileIfNotExistsWithMessages(configFileName, jsonContent);
  displayWarning(
    `You need to update your ${configFileName} to add your xAI API key, ` +
      'or define XAI_API_KEY environment variable.'
  );
}
