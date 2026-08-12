import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import type { ChatXAIInput } from '@langchain/xai';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';
import { warnUnusedConfiguration } from '#src/providers/configurationPassthrough.js';

// Function to process JSON config and create XAI LLM instance
export async function processJsonConfig(
  llmConfig: ChatXAIInput & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatXAI } = await import('@langchain/xai');
  // Use config value if available, otherwise use the environment variable
  const apiKey = llmConfig.apiKey || env.XAI_API_KEY;
  // `ChatXAI` DOES build an OpenAI client, and still consumes none of the user's block: its
  // constructor passes `configuration: { baseURL: fields.baseURL ?? <xAI default> }` to `super`,
  // replacing whatever was set here. So the reason clause is xai's own — the shared native-client
  // sentence would be a false explanation — and the replacements are the top-level fields that were
  // measured to reach the client: `baseURL` (a declared `ChatXAIInput` field) and `timeout` (read
  // by the OpenAI base class from the same spread). Headers reach it by no route at all.
  warnUnusedConfiguration({
    provider: 'xai',
    configuration: (llmConfig as { configuration?: unknown }).configuration,
    consumedPaths: [],
    reason:
      'builds its OpenAI client with a "configuration" block of its own, replacing anything set here',
    // The escape hatch is only followable with the key hint: the "openai" provider reads
    // OPENAI_API_KEY, so a user who moves to it for the headers alone hits a missing-key error.
    guidance:
      'Set "baseURL" or "timeout" as top-level fields of the "llm" block instead, beside "model". ' +
      'Extra headers have no home on this provider at all — to send them, use the "openai" ' +
      'provider with "configuration.baseURL" pointed at the xAI endpoint, and set ' +
      '"apiKeyEnvironmentVariable" to XAI_API_KEY there, since that provider otherwise reads ' +
      'OPENAI_API_KEY.',
  });
  return new ChatXAI({
    ...llmConfig,
    apiKey,
    model: llmConfig.model || getCuratedFallbackModel('xai'),
  });
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('xai', model), force);
  displayWarning(
    `You need to update your ${configFileName} to add your xAI API key, ` +
      'or define XAI_API_KEY environment variable.'
  );
}
