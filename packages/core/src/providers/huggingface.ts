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
 * Hugging Face Inference Providers — OpenAI-compatible router.
 *
 * HF exposes a single OpenAI-compatible Chat Completions endpoint at
 * `https://router.huggingface.co/v1` that fans requests out to the configured
 * inference provider (Cerebras, Groq, Together, SambaNova, hf-inference, …). It
 * supports tool/function calling, streaming and structured outputs, so we reuse
 * LangChain's `ChatOpenAI` exactly like the OpenRouter provider — no dedicated
 * `@langchain/huggingface` package is needed (the JS `@langchain/community`
 * `HuggingFaceInference` is a text-completion LLM with no `bindTools`, so it is
 * unusable for the agent loop).
 *
 * Auth uses a Hugging Face user access token with the "Inference Providers"
 * permission, read from `HF_TOKEN` (canonical) or the `HUGGINGFACEHUB_API_TOKEN`
 * / `HF_API_KEY` aliases.
 *
 * Model ids are Hub repo ids, e.g. `openai/gpt-oss-120b`. You may append a
 * provider/policy suffix understood by the router (`:groq`, `:cheapest`,
 * `:fastest`); it is part of the model id and passes straight through.
 */
// Function to process JSON config and create Hugging Face LLM instance
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: OpenAIChatInput & ChatOpenAIFields & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatOpenAI } = await import('@langchain/openai');
  // Use environment variable if available, otherwise use the config value
  const huggingFaceToken = getApiKey(llmConfig);
  if (!huggingFaceToken) {
    throw new Error(
      'You need to define HF_TOKEN environment variable (a Hugging Face access token ' +
        'with the "Inference Providers" permission), or set apiKey in your config file.'
    );
  }
  const configFields = {
    ...llmConfig,
    apiKey: huggingFaceToken,
    model: llmConfig.model || getCuratedFallbackModel('huggingface'),
    configuration: {
      baseURL: 'https://router.huggingface.co/v1',
      ...(llmConfig.configuration || {}),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (configFields as any).type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (configFields as any).apiKeyEnvironmentVariable;
  return new ChatOpenAI(configFields);
}

function getApiKey(llmConfig: OpenAIChatInput & ChatOpenAIFields & BaseChatModelParams) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conf = llmConfig as any as Record<string, string>;
  if (conf.apiKeyEnvironmentVariable && env[conf.apiKeyEnvironmentVariable]) {
    return env[conf.apiKeyEnvironmentVariable];
  } else {
    return llmConfig.apiKey || env.HF_TOKEN || env.HUGGINGFACEHUB_API_TOKEN || env.HF_API_KEY;
  }
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('huggingface', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure model, ` +
      'or define HF_TOKEN environment variable.'
  );
}
