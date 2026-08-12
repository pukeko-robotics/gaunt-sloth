import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import type { ChatOpenRouterInput } from '@langchain/openrouter';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';
import {
  warnUnappliedConfigurationPath,
  warnUnusedConfiguration,
} from '#src/providers/configurationPassthrough.js';

/**
 * The OpenRouter attribution headers, and the native `ChatOpenRouter` field each one is set from.
 * Declared once because they are read in two places that MUST agree: the `siteUrl`/`siteName`
 * fallback below, and the list of `configuration` paths this factory consumes — if those drift, the
 * orphaned-config warning starts firing on a header that is in fact honoured.
 */
const ATTRIBUTION_HEADERS = { siteUrl: 'HTTP-Referer', siteName: 'X-Title' } as const;

/**
 * The only paths inside a user's `configuration` block that this factory reads. Everything else in
 * it reaches nothing — see the migration note on {@link processJsonConfig}.
 */
const CONSUMED_CONFIGURATION_PATHS = [
  'baseURL',
  `defaultHeaders.${ATTRIBUTION_HEADERS.siteUrl}`,
  `defaultHeaders.${ATTRIBUTION_HEADERS.siteName}`,
] as const;

/**
 * Build a native `ChatOpenRouter` (`@langchain/openrouter`). It is NOT a `ChatOpenAI` subclass: it
 * talks to the OpenRouter REST API through the global `fetch` with no SDK client in between, and
 * `_llmType()` reports `openrouter`.
 *
 * OpenRouter's own options are therefore native TOP-LEVEL fields of the `llm` block, forwarded by
 * the `...restConfig` spread below: `provider` (routing preferences), `models` (the fallback list),
 * `route`, `plugins`, `transforms`, `trace`, `minP`, `topA`, `repetitionPenalty`, `seed`,
 * `logitBias`, `topLogprobs`, `sessionId`. Write them beside `model`, not under `configuration`.
 *
 * Migration note — the OpenAI-client knobs a `configuration` block used to carry are gone, because
 * there is no client to give them to. `configuration.baseURL` still works (mapped to the native
 * `baseURL`), and the two attribution headers are still honoured as a fallback for
 * `siteUrl`/`siteName`. What has no injection point at all is transport: `fetch`, `fetchOptions`,
 * `timeout`, `maxRetries`, `defaultQuery`, `dangerouslyAllowBrowser`, and any other
 * `defaultHeaders` entry. That is an upstream surface gap, not something this module can restore —
 * per-provider transport would need a `fetch` option added to `@langchain/openrouter`.
 *
 * The replacement is PROCESS-WIDE rather than per-provider, and it is verified working: run node
 * with `--use-env-proxy` (or set `NODE_USE_ENV_PROXY=1`) together with `HTTP_PROXY`/`HTTPS_PROXY`,
 * and the global `fetch` this model calls routes through the proxy — measured end to end against a
 * local proxy, with a no-proxy control that stayed direct.
 */
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: ChatOpenRouterInput & BaseChatModelParams & Record<string, unknown>
): Promise<BaseChatModel> {
  const { ChatOpenRouter } = await import('@langchain/openrouter');

  const openRouterApiKey = getApiKey(llmConfig);
  if (!openRouterApiKey) {
    throw new Error(
      'You need to define OPEN_ROUTER_API_KEY environment variable, or set apiKey in your config file.'
    );
  }

  const {
    type: _type,
    apiKeyEnvironmentVariable: _envVar,
    configuration,
    siteUrl,
    siteName,
    ...restConfig
  } = llmConfig;

  const configObj = configuration as
    { baseURL?: string; defaultHeaders?: Record<string, string> } | undefined;

  // The one place that decides whether the user's `configuration.baseURL` is applied; the warning
  // below reads THIS result instead of re-testing the value, so the guard and what the user is told
  // cannot drift apart.
  const baseURLOverride = configObj?.baseURL ? { baseURL: configObj.baseURL } : {};

  warnUnusedConfiguration(
    'openrouter',
    configuration,
    CONSUMED_CONFIGURATION_PATHS,
    // Scope the advice to the options that HAVE a top-level home: told plainly to "put it at the
    // top level", a user with a transport key would move it from a warned location to an unwarned
    // one, which is worse than where they started.
    'OpenRouter\'s own options are native top-level fields of the "llm" block — set "provider" ' +
      '(routing preferences), "models", "route", "plugins" or "transforms" beside "model" rather ' +
      'than under "configuration". Transport settings (proxy, custom fetch, timeout, other ' +
      'headers) have no top-level field and no per-provider hook at all: run node with ' +
      '--use-env-proxy (or set NODE_USE_ENV_PROXY=1) plus HTTP_PROXY/HTTPS_PROXY to route this ' +
      'provider through a proxy process-wide.'
  );

  warnUnappliedConfigurationPath(
    'openrouter',
    configuration,
    'baseURL',
    'baseURL' in baseURLOverride,
    'Give it the full base URL of the OpenRouter-compatible endpoint, or remove it to use the ' +
      'default https://openrouter.ai/api/v1.'
  );

  const resolvedSiteUrl =
    siteUrl ??
    configObj?.defaultHeaders?.[ATTRIBUTION_HEADERS.siteUrl] ??
    'https://gauntsloth.app/';
  const resolvedSiteName =
    siteName ?? configObj?.defaultHeaders?.[ATTRIBUTION_HEADERS.siteName] ?? 'Gaunt Sloth';

  return new ChatOpenRouter({
    ...restConfig,
    apiKey: openRouterApiKey,
    model: llmConfig.model || getCuratedFallbackModel('openrouter'),
    siteUrl: resolvedSiteUrl,
    siteName: resolvedSiteName,
    ...baseURLOverride,
  });
}

function getApiKey(llmConfig: Record<string, unknown>): string | undefined {
  const envVarName = llmConfig.apiKeyEnvironmentVariable as string | undefined;
  if (envVarName && env[envVarName]) {
    return env[envVarName];
  }
  return (
    (llmConfig.apiKey as string | undefined) || env.OPEN_ROUTER_API_KEY || env.OPENROUTER_API_KEY
  );
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('openrouter', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure model, ` +
      'or define OPEN_ROUTER_API_KEY environment variable.'
  );
}
