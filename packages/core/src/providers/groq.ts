import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGroqInput } from '@langchain/groq';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';

// Function to process JSON config and create Groq LLM instance
export async function processJsonConfig(llmConfig: ChatGroqInput): Promise<BaseChatModel> {
  const groq = await import('@langchain/groq');
  // Use config value if available, otherwise use the environment variable
  const groqApiKey = llmConfig.apiKey || env.GROQ_API_KEY;
  return new groq.ChatGroq({
    ...llmConfig,
    apiKey: groqApiKey,
    model: llmConfig.model || getCuratedFallbackModel('groq'),
  });
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('groq', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure model, ` +
      'or define GROQ_API_KEY environment variable.'
  );
}
