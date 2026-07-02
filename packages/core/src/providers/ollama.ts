import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { OpenAIChatInput } from '@langchain/openai';
import { ChatOpenAIFields } from '@langchain/openai';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';

/**
 * Default Ollama daemon host, matching the Ollama CLI/library default. The
 * OpenAI-compatible surface lives under `/v1` on this host. Kept in sync with
 * `DEFAULT_OLLAMA_HOST` in `modelDiscovery.ts`.
 */
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/**
 * Ollama serves an unauthenticated local daemon, but `ChatOpenAI` requires a
 * non-empty `apiKey` string. Send a harmless placeholder so the client builds;
 * the local daemon ignores it.
 */
const OLLAMA_PLACEHOLDER_API_KEY = 'ollama';

/**
 * Resolve the OpenAI-compatible base URL for the local Ollama daemon.
 *
 * Honors the `OLLAMA_HOST` env override (the same variable the Ollama CLI uses).
 * `OLLAMA_HOST` is typically a full URL (`http://127.0.0.1:11434`) or a bare
 * `host:port`; either form is normalized to a `http(s)://host[:port]/v1` base.
 */
function resolveBaseUrl(): string {
  const host = env.OLLAMA_HOST;
  let base: string;
  if (!host) {
    base = DEFAULT_OLLAMA_HOST;
  } else if (/^https?:\/\//.test(host)) {
    base = host.replace(/\/+$/, '');
  } else {
    base = `http://${host}`.replace(/\/+$/, '');
  }
  return `${base}/v1`;
}

// Function to process JSON config and create an Ollama (OpenAI-compatible) LLM instance
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: OpenAIChatInput & ChatOpenAIFields & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatOpenAI } = await import('@langchain/openai');
  // Ollama is local and unauthenticated; ChatOpenAI still needs a non-empty key.
  const apiKey = llmConfig.apiKey || OLLAMA_PLACEHOLDER_API_KEY;
  const configFields = {
    ...llmConfig,
    apiKey,
    model: llmConfig.model || getCuratedFallbackModel('ollama'),
    configuration: {
      baseURL: resolveBaseUrl(),
      ...(llmConfig.configuration || {}),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (configFields as any).type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (configFields as any).apiKeyEnvironmentVariable;

  return new ChatOpenAI(configFields);
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('ollama', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure the model. ` +
      'Ollama runs locally and needs no API key; set OLLAMA_HOST if your daemon ' +
      'is not on the default http://127.0.0.1:11434.'
  );
}
