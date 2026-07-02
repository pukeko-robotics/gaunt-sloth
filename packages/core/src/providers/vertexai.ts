/**
 * @packageDocumentation
 * Google VertexAI preset.
 * This preset requires `gcloud auth login` and `gcloud auth application-default login`.
 * <p>
 * Caveats:
 * This preset does not support discriminatedUnion, anyOf, oneOf in tool signatures,
 * Gaunt Sloth converts those tools to flat calls, and generally they work fine,
 * but sometimes this may lead to some quirks.
 * <p>
 * Hopefully this issue will go away when LangChain switches to the new GenAI dependency.
 */
import { displayWarning } from '#src/utils/consoleUtils.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatGoogleParams } from '@langchain/google/node';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('vertexai', model), force);
  displayWarning(
    'For Google VertexAI you likely to need to do `gcloud auth login` and `gcloud auth application-default login`.'
  );
}

// Function to process JSON config and create VertexAI LLM instance
export async function processJsonConfig(
  llmConfig: ChatGoogleParams & { type?: string; apiKeyEnvironmentVariable?: string }
): Promise<BaseChatModel> {
  const { ChatGoogle } = await import('@langchain/google/node');
  const configFields = {
    ...llmConfig,
    model: llmConfig.model || getCuratedFallbackModel('vertexai'),
    vertexai: true,
  };
  delete configFields.type;
  delete configFields.apiKeyEnvironmentVariable;
  return new ChatGoogle(configFields);
}
