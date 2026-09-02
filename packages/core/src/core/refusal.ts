/**
 * Stop/finish-reason detection for the agent run loop — the **metadata feeder** of the
 * [[EXT-159]] termination taxonomy.
 *
 * This module is the one reader of a message's stop/finish reason. It normalizes the per-provider
 * spellings into two shapes: {@link detectRefusal}, whose {@link RefusalInfo} also drives the
 * user-facing notice, and {@link detectStopMetadata}, which classifies the same metadata into the
 * shared taxonomy for every consumer that only needs to know *why the turn ended*. There is
 * deliberately no second reader of `response_metadata` beside it.
 *
 * Its counterpart is the exception classifier in `core/terminationReason.ts`: a reason that arrives
 * as a thrown error is not in `response_metadata` at all, so nothing here can see it.
 *
 * A *successful* model response (HTTP 200) can carry a stop/finish reason that means the model — or
 * the provider's safety system — declined to answer. The content is usually empty, so without this
 * detection the response falls through the empty-response retry in {@link GthAgentRunner} and is
 * mis-surfaced as "no content, try again" — burning a second, paid call to reproduce a
 * DETERMINISTIC refusal. This module normalizes the per-provider shapes into one signal so the run
 * loop can surface the refusal clearly and terminate (never retry the same prompt).
 *
 * Prior art: hermes-agent `conversation_loop.py` treats `finish_reason == "content_filter"` as a
 * terminal, non-retryable "content policy blocked" outcome and surfaces the model's explanation.
 *
 * Detection lives here (and is called from {@link GthAbstractAgent}, the invoke/stream loop over
 * messages/chunks) because that is the only layer where a message's `response_metadata` /
 * `additional_kwargs` — where finish/stop reasons live — are visible; `GthAgentRunner` only ever
 * sees the rendered string.
 */

import { stripReasoningBlocks } from '#src/core/reasoningBlocks.js';
import type { GthTerminationClassification } from '#src/core/terminationReason.js';

/** One detected refusal, normalized across providers. */
export interface RefusalInfo {
  /** Best-effort provider family the signal came from (for logging / the surfaced message). */
  provider: 'openai' | 'anthropic' | 'bedrock' | 'google' | 'unknown';
  /**
   * The stop/finish reason token that flagged the refusal, lower-cased (e.g. `content_filter`).
   *
   * Lower-cased rather than raw because the token's case is a per-provider spelling, not a fact:
   * Gemini shouts `SAFETY` where OpenAI writes `content_filter`, and this value is matched, logged
   * and carried into the taxonomy's `detail` — the same normalization
   * {@link detectOutputTruncation} already applies to its own token.
   */
  reason: string;
  /** Any model-provided explanation text (empty string when the refusal carried none). */
  explanation: string;
}

/** Read a nested record field defensively (returns undefined for non-objects / missing keys). */
function readField(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

/** Pull any human-readable explanation the refusal carried (message content, then reasoning). */
function extractRefusalText(message: unknown): string {
  const content = readField(message, 'content');
  if (typeof content === 'string' && content.trim().length > 0) return content.trim();
  // Content-block arrays (Anthropic / Bedrock): concatenate any text parts. CFG-33 — minus the
  // model's own thinking: Gemini marks a thought summary `thought: true` and types it exactly like
  // an answer part, so without this it would be pasted verbatim into the refusal notice as the
  // model's "explanation".
  if (Array.isArray(content)) {
    const text = (stripReasoningBlocks(content) as unknown[])
      .map((part) => {
        if (typeof part === 'string') return part;
        const t = readField(part, 'text');
        return typeof t === 'string' ? t : '';
      })
      .join('')
      .trim();
    if (text.length > 0) return text;
  }
  // Some refusals put the explanation only in the reasoning channel.
  const kwargs = readField(message, 'additional_kwargs');
  const reasoning = readField(kwargs, 'reasoning_content');
  if (typeof reasoning === 'string' && reasoning.trim().length > 0) return reasoning.trim();
  // Anthropic exposes the declined text on a dedicated `refusal` field in some SDK shapes.
  const refusalField = readField(kwargs, 'refusal') ?? readField(message, 'refusal');
  if (typeof refusalField === 'string' && refusalField.trim().length > 0)
    return refusalField.trim();
  return '';
}

/**
 * The finish reasons Gemini uses when its safety system declined, lower-cased.
 *
 * Taken from `@langchain/google`'s own `mapGeminiFinishReason` — every reason that package
 * classifies as a `content_filter`, rather than the two a bug report happened to name. The set is
 * Gemini's, so nothing here can widen another provider's detection.
 *
 * Both spellings of the multi-word members are listed because the provider lists both.
 */
const GEMINI_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'safety',
  'recitation',
  'language',
  'blocklist',
  'prohibited_content',
  'prohibited-content',
  'spii',
  'image_safety',
  'image-safety',
  'image_prohibited_content',
  'image-prohibited-content',
  'image_recitation',
  'image-recitation',
]);

/**
 * The first string value among `keys` × `sources`, lower-cased — key-major, so an earlier key wins
 * over an earlier source, else `undefined`.
 *
 * Skipping non-strings rather than stopping at the first *present* value is deliberate: a provider
 * that writes a structured value under one spelling must not hide the plain token another spelling
 * carries. Lower-casing here is what lets every comparison below be written once, in one case.
 */
function firstReasonToken(
  sources: readonly unknown[],
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    for (const source of sources) {
      const value = readField(source, key);
      if (typeof value === 'string' && value.length > 0) return value.toLowerCase();
    }
  }
  return undefined;
}

/**
 * Inspect a finished model message (an `AIMessage` / `AIMessageChunk`, or any object exposing
 * `response_metadata` / `additional_kwargs`) and return a {@link RefusalInfo} when its stop/finish
 * reason indicates a content-policy refusal, else `null`. Defensive: any non-message / unexpected
 * shape yields `null`, so a normal turn is never mistaken for a refusal.
 *
 * Reasons are compared lower-cased, because the case is a provider's spelling and not a fact —
 * Gemini shouts `SAFETY` where OpenAI writes `content_filter`.
 *
 * Covered shapes:
 *  - OpenAI-family `finish_reason: 'content_filter'` (also under `additional_kwargs`).
 *  - Anthropic `stop_reason: 'refusal'`.
 *  - Bedrock Converse guardrail intervention: `stopReason`/`stop_reason`/`finish_reason` ===
 *    `'guardrail_intervened'`, or `additional_kwargs['amazon-bedrock-guardrailAction'] ===
 *    `'INTERVENED'`.
 *  - Bedrock Converse content filter: `stopReason`/`stop_reason`/`finish_reason` ===
 *    `'content_filtered'` (EXT-41 — a distinct `StopReason` enum value from `guardrail_intervened`
 *    that was previously mapped to `null`, i.e. a silent empty turn / false negative).
 *  - Gemini's safety reasons ({@link GEMINI_REFUSAL_REASONS}) under **camelCase `finishReason`**
 *    (CFG-41). That key is the half that has to come first: `@langchain/google`'s streamed chunk
 *    puts `model_provider` and nothing else in `response_metadata` and the reason only in
 *    `additional_kwargs.finishReason`, so a token added without the key would sit on a branch that
 *    never ran for Gemini.
 */
export function detectRefusal(message: unknown): RefusalInfo | null {
  if (!message || typeof message !== 'object') return null;

  const meta = readField(message, 'response_metadata');
  const kwargs = readField(message, 'additional_kwargs');
  const sources = [meta, kwargs];

  // Gather the stop/finish reason from every place providers surface it, in both spellings.
  const finish = firstReasonToken(sources, ['finish_reason', 'finishReason']);
  // The two stop spellings are gathered as SEPARATE values and every branch below tests both, so
  // each spelling is independently sufficient — which is what the covered-shapes list above claims.
  // Collapsing them into one first-match value looks equivalent and is not: a benign `stop_reason`
  // in the same bag would then hide a refusing `stopReason`, turning a detected refusal into a
  // silent `null`. A false negative is the one direction this detector must never acquire, so the
  // three lines a collapse saves are not for sale.
  const stopSnake = firstReasonToken(sources, ['stop_reason']);
  const stopCamel = firstReasonToken(sources, ['stopReason']);

  const explanation = extractRefusalText(message);

  // OpenAI-family content filter.
  if (finish === 'content_filter') {
    return { provider: 'openai', reason: 'content_filter', explanation };
  }
  // Anthropic refusal stop reason.
  if (stopSnake === 'refusal' || stopCamel === 'refusal') {
    return { provider: 'anthropic', reason: 'refusal', explanation };
  }
  // Bedrock Converse guardrail intervention (camelCase `stopReason`, or snake / finish variants).
  if (
    stopCamel === 'guardrail_intervened' ||
    stopSnake === 'guardrail_intervened' ||
    finish === 'guardrail_intervened' ||
    readField(kwargs, 'amazon-bedrock-guardrailAction') === 'INTERVENED' ||
    readField(meta, 'amazon-bedrock-guardrailAction') === 'INTERVENED'
  ) {
    return { provider: 'bedrock', reason: 'guardrail_intervened', explanation };
  }
  // EXT-41 — Bedrock Converse content filter. A distinct `StopReason` enum value from
  // `guardrail_intervened` (both live in the same AWS Converse `StopReason` enum); previously
  // unmapped, so a content-filtered turn returned `null` → the silent empty-turn false negative.
  if (
    stopSnake === 'content_filtered' ||
    stopCamel === 'content_filtered' ||
    finish === 'content_filtered'
  ) {
    return { provider: 'bedrock', reason: 'content_filtered', explanation };
  }
  // CFG-41 — Gemini's safety system. Keyed on the finish reason only: these tokens are Gemini's
  // own, and Gemini never spells the reason as a stop reason.
  if (finish !== undefined && GEMINI_REFUSAL_REASONS.has(finish)) {
    return { provider: 'google', reason: finish, explanation };
  }

  return null;
}

/**
 * The provider spellings of "the answer hit the output cap", lower-cased.
 *
 * The places {@link detectRefusal} reads carry this one too, spelled per family: OpenAI's
 * `finish_reason: 'length'`, Anthropic's and Bedrock's `stop_reason: 'max_tokens'`, Gemini's
 * `finishReason: 'MAX_TOKENS'`, Ollama's `done_reason: 'length'`. LangChain normalizes none of it.
 *
 * Unlike a refusal, a truncation carries **no provider**: the token does not identify one. Both
 * Anthropic and Gemini spell it `max_tokens` once case is normalised, and both OpenAI and Ollama
 * spell it `length` — so naming a family from the token would be a guess stated as a fact. The raw
 * token goes in `detail`, which is what is actually known.
 */
const TRUNCATION_REASONS: ReadonlySet<string> = new Set([
  'length',
  'max_tokens',
  'maxtokens',
  'model_length',
]);

/**
 * Every stop/finish reason token a message carries, lower-cased, from `response_metadata`,
 * `additional_kwargs` and the message itself, in both snake and camel case.
 *
 * This reader is deliberately **wider** than {@link detectRefusal}'s, and the two differences are
 * the point rather than drift. It also takes `done_reason` (Ollama's spelling, which carries a
 * truncation and never a refusal) and the message's own top level, because a truncation is
 * classified from whatever token is present; a refusal is claimed from a token whose *meaning* is
 * known, so widening its reader would start reporting refusals a provider never declared. What the
 * two must never disagree on is the **spelling** of a key, which is what CFG-41 cost: camelCase
 * `finishReason` was read here and not there, so a Gemini refusal was truncation-classifiable and
 * refusal-invisible at the same time.
 */
function stopReasonTokens(message: unknown): string[] {
  const meta = readField(message, 'response_metadata');
  const kwargs = readField(message, 'additional_kwargs');
  const tokens: string[] = [];
  for (const key of ['finish_reason', 'finishReason', 'stop_reason', 'stopReason', 'done_reason']) {
    for (const source of [meta, kwargs, message]) {
      const value = readField(source, key);
      if (typeof value === 'string' && value.length > 0) tokens.push(value.toLowerCase());
    }
  }
  return tokens;
}

/**
 * [[EXT-159]] — the provider's own stop/finish reason for a finished message, or `null` when the
 * message carried none.
 *
 * **`null` is a recorded fact, not a missing one.** No `finish_reason` was written to any log
 * anywhere, so a turn that ended without the provider saying why was indistinguishable from one
 * that ended normally. A caller records the `null` as explicitly as it records a token.
 *
 * Built on the SAME reader {@link detectStopMetadata} uses rather than a second one beside it: a
 * separate scan of `response_metadata` is how two readers come to disagree about what the provider
 * said, and the whole point of this node is that the two halves of the classification share one
 * source. The first token wins, in the key order that shared reader walks, and it is lower-cased
 * there — this is diagnostic detail, never the carrier of a classification.
 */
export function readStopReasonToken(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  return stopReasonTokens(message)[0] ?? null;
}

/**
 * Inspect a finished model message and return an output-truncation classification when its
 * stop/finish reason says the answer hit the output cap, else `null`.
 *
 * A truncated answer is not a refused one and not an error: the turn returns a *successful*
 * response that simply stops mid-thought. Nothing is surfaced from here — the classification exists
 * so a turn that ended this way is not indistinguishable from one the model finished.
 */
export function detectOutputTruncation(message: unknown): GthTerminationClassification | null {
  if (!message || typeof message !== 'object') return null;
  for (const token of stopReasonTokens(message)) {
    if (TRUNCATION_REASONS.has(token)) {
      return { category: 'output_truncated', detail: token };
    }
  }
  return null;
}

/**
 * The metadata feeder, as one call: classify a finished model message's stop/finish reason into the
 * [[EXT-159]] taxonomy, or `null` when it says nothing worth recording.
 *
 * `null` for an ordinary end is deliberate. Only a *terminal and interesting* reason is reported —
 * a refusal or a truncation — because every other end of a turn is classified by the site that
 * actually ends it, and a reader that reported `completed` off a mid-turn tool round would pin the
 * wrong reason before the real one happened.
 */
export function detectStopMetadata(message: unknown): GthTerminationClassification | null {
  const refusal = detectRefusal(message);
  if (refusal) return classifyRefusal(refusal);
  return detectOutputTruncation(message);
}

/**
 * The taxonomy classification a {@link RefusalInfo} stands for.
 *
 * Exported so a call site that already holds the detected {@link RefusalInfo} — because it needs
 * the explanation text for the user-facing notice — records the same classification
 * {@link detectStopMetadata} would, rather than re-deriving the mapping beside it.
 */
export function classifyRefusal(info: RefusalInfo): GthTerminationClassification {
  return { category: 'content_refusal', provider: info.provider, detail: info.reason };
}

/**
 * Build the clear, user-facing message shown when the model declines. Framed as the model /
 * provider's own policy decision (not a Gaunt Sloth fault) and stated as terminal — a refusal is
 * deterministic for the same input, so retrying as-is will not help. Any model-provided explanation
 * is included verbatim. This string is BOTH surfaced to the console and RETURNED as the turn's
 * answer, so the non-interactive caller writes it to the output file and exits `ok` (it is a
 * successful, if declined, response — not a failure to be re-wrapped as "Failed to get answer").
 */
export function buildRefusalMessage(info: RefusalInfo): string {
  const head =
    'The model declined to respond (safety refusal / content filter) — this is the ' +
    "model/provider's own policy decision, not a Gaunt Sloth error.";
  const detail = info.explanation
    ? `Model's explanation: ${info.explanation}`
    : 'The model provided no explanation.';
  const hint =
    'A refusal is deterministic for the same input — rephrase the request or try a different ' +
    'model rather than re-running it as-is.';
  return `${head}\n\n${detail}\n\n${hint}`;
}
