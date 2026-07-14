import { Command } from 'commander';
import {
  detectProviders,
  type DetectedProvider,
  type ProviderId,
} from '@gaunt-sloth/core/providers/modelDiscovery.js';
import {
  enrichModels,
  CATALOG_ATTRIBUTION,
  type EnrichedModel,
  type ModelCatalogEntry,
} from '@gaunt-sloth/core/providers/modelCatalog.js';
import { display, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';

/**
 * GS2-6 (B16) — `gth models`: list the models available on this machine, enriched with
 * cost / context-limit / capability metadata from models.dev.
 *
 * `/v1/models` discovery stays authoritative for *what is callable* (`modelDiscovery.ts`);
 * models.dev only decorates cloud model ids. A cloud model models.dev has never heard of is still
 * listed (unenriched), and if models.dev is unreachable the whole list still prints — just without
 * metadata. Local/self-hosted providers (ollama) get no catalog lookup at all.
 *
 * - `gth models` — list detected providers and their (enriched) models.
 * - `gth models --refresh` — force a models.dev re-fetch past the cache TTL before listing.
 * - `gth models --provider <id>` — scope the listing to a single provider.
 */
export function modelsCommand(program: Command): void {
  program
    .command('models')
    .description('List available models, enriched with cost/context metadata from models.dev')
    .option('--refresh', 'Force a models.dev catalog re-fetch past the cache TTL')
    .option('--provider <id>', 'Only list models for a single provider (e.g. anthropic, openai)')
    .action(async (options: { refresh?: boolean; provider?: string }) => {
      const providers = await detectProviders();
      const filtered = options.provider
        ? providers.filter((p) => p.id === options.provider)
        : providers;

      if (options.provider && filtered.length === 0) {
        displayWarning(
          `Unknown provider "${options.provider}". Known: ${providers.map((p) => p.id).join(', ')}.`
        );
        return;
      }

      let anyEnriched = false;
      for (const provider of filtered) {
        const enriched = await enrichModels(provider.id, provider.models, {
          refresh: options.refresh,
        });
        printProvider(provider, enriched);
        if (enriched.some((m) => m.enrichment)) anyEnriched = true;
      }

      // Only claim attribution when we actually surfaced models.dev metadata.
      if (anyEnriched) {
        display('');
        display(CATALOG_ATTRIBUTION);
      }
    });
}

/** Print one provider's header and its (enriched) model list. */
function printProvider(provider: DetectedProvider, models: EnrichedModel[]): void {
  const status = provider.available ? '' : ' (no key detected)';
  displayInfo(`\n${provider.label} [${provider.id}]${status}`);
  if (models.length === 0) {
    display('  (no models discovered)');
    return;
  }
  for (const model of models) {
    const star = model.preferred ? '⭐ ' : '   ';
    const meta = formatEnrichment(model.enrichment);
    display(`  ${star}${model.id}${meta ? `  ${meta}` : ''}`);
  }
}

/**
 * Render a model's catalog metadata as a compact bracketed suffix, e.g.
 * `[ctx 200k · out 64k · in $5/1M · out $25/1M · tools · reasoning] *`. Returns '' when there is no
 * enrichment (the model is still listed — it is simply callable-but-unenriched). Costs are US$ per
 * 1M tokens (models.dev's unit); the trailing `*` ties back to the attribution footer.
 */
export function formatEnrichment(entry: ModelCatalogEntry | undefined): string {
  if (!entry) return '';
  const parts: string[] = [];
  if (entry.limit?.context !== undefined) parts.push(`ctx ${formatTokens(entry.limit.context)}`);
  if (entry.limit?.output !== undefined) parts.push(`out ${formatTokens(entry.limit.output)}`);
  if (entry.cost?.input !== undefined) parts.push(`in $${entry.cost.input}/1M`);
  if (entry.cost?.output !== undefined) parts.push(`out $${entry.cost.output}/1M`);
  if (entry.toolCall) parts.push('tools');
  if (entry.reasoning) parts.push('reasoning');
  if (parts.length === 0) return '';
  return `[${parts.join(' · ')}] *`;
}

/** Human-friendly token count: 200000 → "200k", 1500000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// Re-export for callers that want the provider-id type alongside the command.
export type { ProviderId };
