import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatGoogleParams } from '@langchain/google/node';

import { writeFileIfNotExistsWithMessages } from '#src/utils/fileUtils.js';

// Function to process JSON config and create Google GenAI LLM instance
export async function processJsonConfig(
  llmConfig: ChatGoogleParams & { type?: string; apiKeyEnvironmentVariable?: string }
): Promise<BaseChatModel> {
  const { ChatGoogle } = await import('@langchain/google/node');
  // Use config value if available, otherwise use the environment variable
  const googleApiKey = llmConfig.apiKey || env.GOOGLE_API_KEY;
  const configFields = {
    ...llmConfig,
    apiKey: googleApiKey,
    model: llmConfig.model || 'gemini-3.5-flash',
    platformType: 'gai' as const,
  };
  delete configFields.type;
  delete configFields.apiKeyEnvironmentVariable;
  return new ChatGoogle(configFields);
}

const jsonContent = `{
  "llm": {
    "type": "google-genai",
    "model": "gemini-3.5-flash"
  }
}`;

export function init(configFileName: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeFileIfNotExistsWithMessages(configFileName, jsonContent);
  displayWarning(
    `You need to update your ${configFileName} to add your Google GenAI API key, ` +
      'or define GOOGLE_API_KEY environment variable.'
  );
}
