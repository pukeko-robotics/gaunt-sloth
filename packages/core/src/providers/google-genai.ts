import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatGoogleParams } from '@langchain/google/node';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';
import { applyGeminiToolSchemaSanitizer } from '#src/providers/geminiSchemaSanitizer.js';
import { applyGeminiThoughtSummaries } from '#src/providers/geminiThinking.js';
import { warnUnusedConfiguration } from '#src/providers/configurationPassthrough.js';

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
    model: llmConfig.model || getCuratedFallbackModel('google-genai'),
    platformType: 'gai' as const,
  };
  delete configFields.type;
  delete configFields.apiKeyEnvironmentVariable;
  // `ChatGoogle` is a native client for the Gemini API, so nothing in a `configuration` block
  // reaches it — say so before dropping it.
  warnUnusedConfiguration(
    'google-genai',
    (llmConfig as { configuration?: unknown }).configuration,
    [],
    'ChatGoogle talks to the Gemini API through its own client instead: set "customHeaders", ' +
      '"endpoint" or "apiVersion" as top-level fields of the "llm" block beside "model".'
  );
  // GS2-58: normalise every tool's JSON-Schema at the ChatGoogle boundary so Gemini's OpenAPI-3.0
  // subset accepts built-in, custom, and MCP tools alike (see geminiSchemaSanitizer).
  // CFG-33: ask for the thought summaries of the thinking Gemini already does and already bills,
  // so the reasoning channel is fed instead of discarded (see geminiThinking).
  return applyGeminiThoughtSummaries(applyGeminiToolSchemaSanitizer(new ChatGoogle(configFields)));
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('google-genai', model), force);
  displayWarning(
    `You need to update your ${configFileName} to add your Google GenAI API key, ` +
      'or define GOOGLE_API_KEY environment variable.'
  );
}
