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
 * OpenAI reasoning-model families that reject any non-default `temperature`: the API 400s with
 * "Unsupported value: 'temperature' does not support 0 ... Only the default (1) value is
 * supported." (confirmed live for gpt-5.x, o3-mini, o4-mini). The denylist matches the
 * `gpt-5` family and the `o<digit>` series (o1/o3/o4/...) so it stays future-proof for new
 * minor/point releases (gpt-5.5, o5, etc.) without enumerating every id. Models like `gpt-4o`
 * are NOT matched and keep their configured temperature.
 */
const TEMPERATURE_RESTRICTED_MODEL = /^(gpt-5|o\d)/i;

/** The only `temperature` value OpenAI reasoning models accept (their fixed default). */
const SUPPORTED_DEFAULT_TEMPERATURE = 1;

function isTemperatureRestrictedModel(model: string | undefined): boolean {
  return !!model && TEMPERATURE_RESTRICTED_MODEL.test(model);
}

// Function to process JSON config and create OpenAI LLM instance
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: OpenAIChatInput & ChatOpenAIFields & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatOpenAI } = await import('@langchain/openai');
  // Use environment variable if available, otherwise use the config value
  const openaiApiKey = getApiKey(llmConfig);
  const configFields = {
    ...llmConfig,
    apiKey: openaiApiKey,
    model: llmConfig.model || getCuratedFallbackModel('openai'),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (configFields as any).type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (configFields as any).apiKeyEnvironmentVariable;

  // OpenAI reasoning models (gpt-5.x, o-series) reject any non-default temperature with a 400.
  // A user setting `temperature: 0` (e.g. via `exec -t 0` for determinism) would otherwise fail
  // even though the model is valid. Drop the unsupported temperature and warn rather than 400.
  if (
    isTemperatureRestrictedModel(configFields.model) &&
    configFields.temperature !== undefined &&
    configFields.temperature !== SUPPORTED_DEFAULT_TEMPERATURE
  ) {
    displayWarning(
      `Model "${configFields.model}" does not support a custom temperature ` +
        `(only the default ${SUPPORTED_DEFAULT_TEMPERATURE} is allowed); ` +
        `ignoring the configured temperature of ${configFields.temperature}.`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (configFields as any).temperature;
  }

  return new ChatOpenAI(configFields);
}

function getApiKey(llmConfig: OpenAIChatInput & ChatOpenAIFields & BaseChatModelParams) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conf = llmConfig as any as Record<string, string>;
  if (conf.apiKeyEnvironmentVariable && env[conf.apiKeyEnvironmentVariable]) {
    return env[conf.apiKeyEnvironmentVariable];
  } else {
    return llmConfig.apiKey || env.OPENAI_API_KEY;
  }
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('openai', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure model, ` +
      'or define OPENAI_API_KEY environment variable.'
  );
}
