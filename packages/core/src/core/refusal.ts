/**
 * EXT-37 — content-policy refusal detection for the agent run loop.
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

/** One detected refusal, normalized across providers. */
export interface RefusalInfo {
  /** Best-effort provider family the signal came from (for logging / the surfaced message). */
  provider: 'openai' | 'anthropic' | 'bedrock' | 'unknown';
  /** The raw stop/finish reason token that flagged the refusal (e.g. `content_filter`). */
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
  // Content-block arrays (Anthropic / Bedrock): concatenate any text parts.
  if (Array.isArray(content)) {
    const text = content
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
 * Inspect a finished model message (an `AIMessage` / `AIMessageChunk`, or any object exposing
 * `response_metadata` / `additional_kwargs`) and return a {@link RefusalInfo} when its stop/finish
 * reason indicates a content-policy refusal, else `null`. Defensive: any non-message / unexpected
 * shape yields `null`, so a normal turn is never mistaken for a refusal.
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
 */
export function detectRefusal(message: unknown): RefusalInfo | null {
  if (!message || typeof message !== 'object') return null;

  const meta = readField(message, 'response_metadata');
  const kwargs = readField(message, 'additional_kwargs');

  // Gather the stop/finish reason from every place providers surface it.
  const finishReason =
    readField(meta, 'finish_reason') ?? readField(kwargs, 'finish_reason') ?? undefined;
  const stopReasonSnake =
    readField(meta, 'stop_reason') ?? readField(kwargs, 'stop_reason') ?? undefined;
  const stopReasonCamel =
    readField(meta, 'stopReason') ?? readField(kwargs, 'stopReason') ?? undefined;

  const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const finish = asString(finishReason);
  const stopSnake = asString(stopReasonSnake);
  const stopCamel = asString(stopReasonCamel);

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
    stopCamel === 'content_filtered' ||
    stopSnake === 'content_filtered' ||
    finish === 'content_filtered'
  ) {
    return { provider: 'bedrock', reason: 'content_filtered', explanation };
  }

  return null;
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
