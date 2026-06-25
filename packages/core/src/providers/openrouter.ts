import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { OpenAIChatInput } from '@langchain/openai';
import { ChatOpenAIFields } from '@langchain/openai';

import { writeFileIfNotExistsWithMessages } from '#src/utils/fileUtils.js';

// Function to process JSON config and create OpenRouter LLM instance
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: OpenAIChatInput & ChatOpenAIFields & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatOpenAI } = await import('@langchain/openai');
  // Use environment variable if available, otherwise use the config value
  const openRouterApiKey = getApiKey(llmConfig);
  if (!openRouterApiKey) {
    throw new Error(
      'You need to define OPEN_ROUTER_API_KEY environment variable, or set apiKey in your config file.'
    );
  }
  const configFields = {
    ...llmConfig,
    apiKey: openRouterApiKey,
    model: llmConfig.model || 'qwen/qwen3-coder',
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      ...(llmConfig.configuration || {}),
      defaultHeaders: {
        'HTTP-Referer': 'https://gauntsloth.app/',
        'X-Title': 'Gaunt Sloth',
      },
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
    return llmConfig.apiKey || env.OPEN_ROUTER_API_KEY || env.OPENROUTER_API_KEY;
  }
}

const jsonContent = `{
  "llm": {
    "type": "openrouter",
    "model": "qwen/qwen3-coder"
  }
}`;

export function init(configFileName: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeFileIfNotExistsWithMessages(configFileName, jsonContent);
  displayWarning(
    `You need to edit your ${configFileName} to configure model, ` +
      'or define OPEN_ROUTER_API_KEY environment variable.'
  );
}
