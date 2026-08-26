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
import { applyGeminiToolSchemaSanitizer } from '#src/providers/geminiSchemaSanitizer.js';
import { applyGeminiThoughtSummaries } from '#src/providers/geminiThinking.js';
import {
  NATIVE_CLIENT_REASON,
  warnUnusedConfiguration,
} from '#src/providers/configurationPassthrough.js';

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
    // CFG-58 — pick the provider from the config, not from whatever key happens to be exported.
    // `@langchain/google` ranks an ambient `GOOGLE_API_KEY` ABOVE service-account credentials and
    // ADC (its documented order), and `NodeApiClient.fetch` sets the api-key header ahead of both
    // branches. So an AI Studio key exported for a `google-genai` profile silently turns a
    // `vertexai` session into a Vertex EXPRESS session: express auth header, and an express URL
    // with no project or location. The user configured Vertex; only the environment disagreed.
    //
    // An EMPTY STRING is what demotes it, and none of the near-misses do:
    //   - `googleAuthOptions` alone does NOT work. The client builds `GoogleAuth` from it and then
    //     never reaches that branch, because the api-key check comes first.
    //   - `undefined` / `null` do NOT work either. The lookup is `params.apiKey ?? env`, and `??`
    //     treats both as absent, so the ambient key flows straight back in.
    //   - Unsetting the variable is not ours to do: this process also runs other providers, other
    //     tools and spawned children.
    // An empty string is not nullish, so the env lookup is skipped; it is falsy, so the constructor
    // still builds ADC and `fetch` still takes the ADC branch. The library models this state
    // itself — its own `hasApiKey()` is `typeof apiKey === 'string' && apiKey !== ''`.
    //
    // A key the user actually WROTE still wins, and must: an `apiKey` on the `llm` block is how
    // Vertex express mode is requested on purpose. Only the ambient environment is demoted.
    apiKey: llmConfig.apiKey || '',
  };
  delete configFields.type;
  delete configFields.apiKeyEnvironmentVariable;
  // `ChatGoogle` is a native client for the Gemini API, so nothing in a `configuration` block
  // reaches it — say so before dropping it.
  warnUnusedConfiguration({
    provider: 'vertexai',
    configuration: (llmConfig as { configuration?: unknown }).configuration,
    consumedPaths: [],
    reason: NATIVE_CLIENT_REASON,
    guidance:
      'ChatGoogle talks to Vertex AI through its own client instead: set "customHeaders", ' +
      '"endpoint", "apiVersion" or "location" as top-level fields of the "llm" block beside ' +
      '"model".',
  });
  // GS2-58: normalise every tool's JSON-Schema at the ChatGoogle boundary so Gemini's OpenAPI-3.0
  // subset accepts built-in, custom, and MCP tools alike (see geminiSchemaSanitizer).
  // CFG-33: Vertex serves the same Gemini models through the same ChatGoogle class, so it has the
  // same silently-discarded thinking; ask for the summaries here too (see geminiThinking).
  return applyGeminiThoughtSummaries(applyGeminiToolSchemaSanitizer(new ChatGoogle(configFields)));
}
