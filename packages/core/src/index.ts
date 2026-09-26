export * from '#src/constants.js';
export * from '#src/core/types.js';
export { gthLeanAgentFactory } from '#src/core/gthLeanAgentFactory.js';
export * from '#src/core/compaction.js';
// EXT-161 — the preventive compaction threshold and the window resolution behind it, re-exported as
// TYPES only: both are reachable from `GthAgentInterface.autocompact`, so an embedder that names
// the agent surface must be able to name these too. The resolvers and the ollama/unknown window
// sources stay internal — the runner wires them, and nothing outside core imports them through
// this barrel. `AutocompactController` is the one runtime export: it is a class on that surface,
// and a class an embedder can name but not construct is what the value-surface gate refuses.
export { AutocompactController } from '#src/core/compactionThreshold.js';
export type {
  AutocompactConfig,
  AutocompactControllerOptions,
  AutocompactStatus,
  AutocompactThresholdOrigin,
  ResolvedAutocompactConfig,
} from '#src/core/compactionThreshold.js';
export type {
  ContextWindowCheck,
  ContextWindowOrigin,
  ContextWindowReading,
  ContextWindowResolutionOptions,
  ContextWindowSource,
  OllamaLikeModel,
  ResolvedContextWindow,
} from '#src/core/contextWindow.js';
export * from '#src/config.js';
export * from '#src/providers/modelDiscovery.js';
// EXT-161 — the models.dev catalog types, reachable from the context-window resolution options an
// embedder can now name. Types only, for the same reason: the fetch, the cache constants and the
// `gth models` enrichment are the catalog's own business, not the agent surface.
export type {
  CatalogOptions,
  EnrichedModel,
  ModelCatalogEntry,
  ModelCost,
  ModelLimit,
  ModelModalities,
  ProviderCatalog,
} from '#src/providers/modelCatalog.js';
export * from '#src/history/historyStore.js';
export * from '#src/history/recordSession.js';
export * from '#src/history/historyFormat.js';
export * from '#src/history/conversationRef.js';
// GS2-107 — the shapes the history formatters take as arguments. Re-exported as TYPES only: the
// retention functions themselves operate on an open `DatabaseSync` and are not part of the public
// surface, but an embedder that calls `formatStoreSizeLine` has to be able to name what it passes.
export type {
  CheckpointStoreStats,
  PrunableConversation,
  ReclaimSummary,
  ThreadUsage,
} from '#src/history/checkpointRetention.js';
