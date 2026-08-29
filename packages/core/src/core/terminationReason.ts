/**
 * @packageDocumentation
 * EXT-159 — the typed reason a run ended.
 *
 * A run can stop for a dozen unrelated causes — a rate limit, a provider-side fault, a full context
 * window, a content-policy refusal, the approvals gate, a tool-error budget, the user pressing Esc
 * — and every one of them used to reach the surface as one untyped sentence. This module is the
 * single taxonomy those causes are classified into, so the fact "why did this end" is carried as a
 * value rather than reconstructed from prose.
 *
 * **Two feeders converge here, and they are not interchangeable.**
 *
 * - A **metadata reader** (`detectStopMetadata` in `core/refusal.ts`, called from
 *   `GthAbstractAgent`) handles reasons that arrive *on a message* — a stop/finish reason in
 *   `response_metadata` or
 *   `additional_kwargs`. It sits at that layer because that is the only place the metadata is
 *   visible.
 * - An **exception classifier** ({@link classifyThrownTermination}, called from the runner's
 *   catches) handles reasons that arrive as a *thrown error*. Those are not in `response_metadata`
 *   at all, so no metadata reader can ever see them.
 *
 * Built as one metadata reader the whole thrown-error half of the class falls outside it; built as
 * two taxonomies every consumer grows its own. Hence: two feeders, one taxonomy.
 *
 * **Retryability is two facts, never a boolean.** `@langchain/core` exports a typed
 * `ContextOverflowError` that stamps itself non-retryable in its own constructor. That is right for
 * "send the same prompt again" and exactly backwards for the remedy this cause actually has, which
 * is to send a *smaller* one. {@link GthTerminationReason} therefore carries
 * {@link GthTerminationReason#retryableAsIs} and
 * {@link GthTerminationReason#retryableAfterRemedy} separately, with the remedy named.
 *
 * Classification only. Nothing here surfaces anything, formats anything, or changes what a run
 * does; the user-facing strings stay where they are and keep their own wording.
 */

import { ContextOverflowError } from '@langchain/core/errors';

/**
 * What ended the run, as one closed vocabulary shared by every site and every consumer.
 *
 * Members are causes, not messages: two sites that stop for the same reason report the same
 * category and are told apart by {@link GthTerminationSite}.
 */
export type GthTerminationCategory =
  /** The model finished of its own accord — the ordinary end of a turn. */
  | 'completed'
  /** The turn produced no content at all (no refusal, no error, nothing). */
  | 'empty_response'
  /** The model or the provider's safety system declined to answer. */
  | 'content_refusal'
  /** The answer was cut off against the output cap rather than finished. */
  | 'output_truncated'
  /** Prompt plus history exceeded the model's input window. */
  | 'context_overflow'
  /** The provider refused for rate/quota reasons (HTTP 429). */
  | 'rate_limited'
  /** Credentials were missing, wrong or unauthorised (HTTP 401/403). */
  | 'auth_failed'
  /** The provider rejected the request itself (HTTP 400) for a reason retrying cannot change. */
  | 'invalid_request'
  /** A fault on the provider's side (HTTP 5xx, "internal error during token generation"). */
  | 'provider_error'
  /** The request never completed at the transport level. */
  | 'network_error'
  /** A deadline elapsed before the run finished. */
  | 'timeout'
  /** The user stopped it — Esc, a cancelled signal, a closed client. */
  | 'cancelled'
  /** The approvals gate deliberately ended the run. */
  | 'approval_stop'
  /** The tool-error budget ended the run rather than spend another model call. */
  | 'tool_error_budget'
  /** The tool-loop guard ended a no-progress identical-call loop. */
  | 'tool_loop_guard'
  /** A tool threw, and the failure ended the turn. */
  | 'tool_error'
  /** The graph suspended on an `interrupt()` and is waiting to be resumed. */
  | 'suspended'
  /** The graph hit its recursion limit. */
  | 'recursion_limit'
  /** The consumer stopped consuming the turn before it ended. */
  | 'abandoned'
  /** Nothing in the taxonomy matched — recorded as such rather than guessed at. */
  | 'unknown';

/**
 * Where the classification was made, as a stable identifier per termination site.
 *
 * The site is a distinct fact from the category: several sites classify into the same category (the
 * runner's two exception wrappers both report whatever the classifier says), and several categories
 * can be reported from one site (an aborted stream and a suspended graph leave `streamWithEvents`
 * at the same place). Diagnosis needs both.
 */
export type GthTerminationSite =
  /** `GthAgentRunner.processMessages` returned an answer. */
  | 'runner.completed'
  /** The streamed turn was empty and the non-streaming fallback was empty too. */
  | 'runner.empty-after-fallback'
  /** The non-streaming turn produced no content. */
  | 'runner.empty-invoke'
  /** An approvals stop re-thrown out of the stream drain. */
  | 'runner.stream-approval-stop'
  /** An approvals stop re-thrown out of the turn. */
  | 'runner.turn-approval-stop'
  /** The stream drain threw. */
  | 'runner.stream-error'
  /** The turn threw. */
  | 'runner.turn-error'
  /** `GthAgentRunner.processMessagesWithEvents` drained its stream to the end. */
  | 'runner.events-completed'
  /** The typed-event turn ended because its signal was aborted. */
  | 'runner.events-cancelled'
  /** The typed-event turn threw. */
  | 'runner.events-error'
  /** The consumer stopped consuming the typed-event turn before it ended. */
  | 'runner.events-abandoned'
  /** The metadata reader fired on the non-streaming `invoke` path. */
  | 'agent.invoke-stop-metadata'
  /** The metadata reader fired on the string-streaming path. */
  | 'agent.stream-stop-metadata'
  /** The metadata reader fired on the typed-event path. */
  | 'agent.events-stop-metadata'
  /** A `ToolException` was turned into the turn's answer on the `invoke` path. */
  | 'agent.invoke-tool-exception'
  /** The string-streaming path ended on Esc / an abort. */
  | 'agent.stream-cancelled'
  /** `streamWithEvents` ended on a suspend or an abort. */
  | 'agent.events-ended'
  /** `streamWithEventsResume` ended on a suspend or an abort. */
  | 'agent.events-resume-ended'
  /** The tool-error budget's `jumpTo: 'end'`. */
  | 'middleware.tool-error-budget'
  /** The tool-loop guard's `jumpTo: 'end'`. */
  | 'middleware.tool-loop-guard';

/**
 * Which feeder produced the classification.
 *
 * `metadata` — read off a message's stop/finish reason. `exception` — classified from a thrown
 * error. `control` — the runtime itself decided to end the run (a gate, a middleware, a
 * cancellation, an ordinary completion), so there was nothing to classify.
 */
export type GthTerminationSource = 'metadata' | 'exception' | 'control';

/**
 * What would have to change before a retry is worth making.
 *
 * Named rather than implied, because {@link GthTerminationReason#retryableAfterRemedy} is only
 * actionable if a consumer knows *which* remedy it is being told about.
 */
export type GthTerminationRemedy =
  /** Send less: compact the history, drop context, summarise. */
  | 'reduce-context'
  /** Wait, then send the same thing again. */
  | 'back-off'
  /** Send something different — rephrase, narrow, change approach. */
  | 'change-request'
  /** Send it to a different model. */
  | 'change-model'
  /** Repair credentials or configuration first. */
  | 'fix-credentials'
  /** Nothing is wrong: the run is parked and can be continued where it stopped. */
  | 'resume';

/** The retry posture of a category — the two facts, plus the remedy the second one refers to. */
export interface GthTerminationPosture {
  /** Is sending the identical request again a sane thing to do? */
  retryableAsIs: boolean;
  /** Is sending it again worthwhile once {@link remedy} has been applied? */
  retryableAfterRemedy: boolean;
  /** The change that makes {@link retryableAfterRemedy} true; absent when it is `false`. */
  remedy?: GthTerminationRemedy;
}

/**
 * The single posture table.
 *
 * One place decides what a category means for retrying, so the three consumers this taxonomy exists
 * for — a retry posture, a "never retry a 400, a 429 is a different case" ruling, a nudge-or-back-off
 * decision — read the same answer instead of each deriving its own.
 */
const POSTURE: Readonly<Record<GthTerminationCategory, GthTerminationPosture>> = {
  // Nothing went wrong; there is nothing to retry.
  completed: { retryableAsIs: false, retryableAfterRemedy: false },
  // The one cause the runtime already retries as-is, and it is right to: an empty turn is usually
  // transient. A model that keeps returning nothing needs a different model, not another attempt.
  empty_response: { retryableAsIs: true, retryableAfterRemedy: true, remedy: 'change-model' },
  // A refusal is deterministic for the same input, so the same prompt refuses again.
  content_refusal: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'change-request' },
  // The answer was cut off, not refused: asking for less, or for a continuation, gets the rest.
  output_truncated: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'change-request' },
  // THE case the two fields exist for. `ContextOverflowError.getRetryable()` is false, which is
  // right for the same prompt and exactly wrong for the smaller one compaction exists to send.
  context_overflow: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'reduce-context' },
  // A 429 answered immediately is a 429 again; waiting is the whole remedy.
  rate_limited: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'back-off' },
  auth_failed: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'fix-credentials' },
  // A rejected request is rejected identically every time, and a repaired request is a new request
  // rather than a retry — so neither field is true and no remedy is named.
  invalid_request: { retryableAsIs: false, retryableAfterRemedy: false },
  // A provider-side fault is the transient case: the same request often succeeds on the next try.
  provider_error: { retryableAsIs: true, retryableAfterRemedy: true, remedy: 'back-off' },
  network_error: { retryableAsIs: true, retryableAfterRemedy: true, remedy: 'back-off' },
  timeout: { retryableAsIs: true, retryableAfterRemedy: true, remedy: 'back-off' },
  // The user chose to stop. Retrying without being asked overrides the one decision they made.
  cancelled: { retryableAsIs: false, retryableAfterRemedy: false },
  // The gate refused. Re-running the refused command automatically is the failure the gate exists
  // to prevent, so neither field offers it.
  approval_stop: { retryableAsIs: false, retryableAfterRemedy: false },
  // Both guards end a loop that is going nowhere. Repeating it goes nowhere again; a changed
  // approach is exactly what each guard's own notice asks the model for.
  tool_error_budget: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'change-request' },
  tool_loop_guard: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'change-request' },
  tool_error: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'change-request' },
  // Not a failure at all: the run is parked mid-flight and continues where it stopped.
  suspended: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'resume' },
  recursion_limit: { retryableAsIs: false, retryableAfterRemedy: true, remedy: 'change-request' },
  abandoned: { retryableAsIs: false, retryableAfterRemedy: false },
  // Unclassified is not "probably fine": nothing is known, so nothing is offered.
  unknown: { retryableAsIs: false, retryableAfterRemedy: false },
};

/** The retry posture of a category. */
export function terminationPosture(category: GthTerminationCategory): GthTerminationPosture {
  return POSTURE[category] ?? POSTURE.unknown;
}

/** Why a run ended, as one value. */
export interface GthTerminationReason extends GthTerminationPosture {
  /** The taxonomy member. */
  category: GthTerminationCategory;
  /** The site that classified it. */
  site: GthTerminationSite;
  /** Which feeder classified it. */
  source: GthTerminationSource;
  /** Provider family, where the classification knew one. */
  provider?: string;
  /**
   * The raw token the classification was made from — a `finish_reason`, a `stop_reason`, an error
   * name or status. Diagnostic detail, never the carrier of the classification itself.
   */
  detail?: string;
}

/** The classification a feeder produces, before a site is attached to it. */
export interface GthTerminationClassification {
  category: GthTerminationCategory;
  provider?: string;
  detail?: string;
}

/**
 * Build a {@link GthTerminationReason}: attach a site and a feeder to a classification and fill in
 * the posture from the one table. Every site builds through here, so no site can invent a posture.
 */
export function terminationReason(
  site: GthTerminationSite,
  source: GthTerminationSource,
  classification: GthTerminationCategory | GthTerminationClassification
): GthTerminationReason {
  const resolved: GthTerminationClassification =
    typeof classification === 'string' ? { category: classification } : classification;
  return {
    category: resolved.category,
    site,
    source,
    ...terminationPosture(resolved.category),
    ...(resolved.provider === undefined ? {} : { provider: resolved.provider }),
    ...(resolved.detail === undefined ? {} : { detail: resolved.detail }),
  };
}

/**
 * Substrings providers use when the input exceeds the model's window, matched case-insensitively.
 *
 * These sit **beside** `@langchain/core`'s own detection rather than behind it. LangChain types the
 * error by substring-matching the provider's English prose in each provider package, so a provider
 * rewording its 400 drops the typed class with nothing going red — and it covers only half our
 * providers to begin with. A fallback that repeats the match here is what keeps the classification
 * from quietly un-typing itself on a dependency bump.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly string[] = [
  'context_length_exceeded',
  'context length exceeded',
  'maximum context length',
  'exceeds the context window',
  'exceed the context window',
  'input tokens exceed the configured limit',
  'prompt is too long',
  'too many tokens',
  'reduce the length of the messages',
  'request too large',
];

/** Substrings that mean the provider refused for rate or quota reasons. */
const RATE_LIMIT_PATTERNS: readonly string[] = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'quota exceeded',
  'resource_exhausted',
  'resource exhausted',
  'overloaded_error',
];

/** Substrings that mean the caller was not authorised. */
const AUTH_PATTERNS: readonly string[] = [
  'unauthorized',
  'unauthenticated',
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'api key not valid',
  'permission denied',
  'permission_denied',
  'authentication_error',
  'invalid_grant',
  'forbidden',
];

/** Substrings that mean the fault was on the provider's side. */
const PROVIDER_ERROR_PATTERNS: readonly string[] = [
  'internal error',
  'internal server error',
  'internal_server_error',
  'service unavailable',
  'bad gateway',
  'server_error',
  'overloaded',
  'model is overloaded',
  'try again later',
];

/** Substrings that mean the request never completed at the transport level. */
const NETWORK_PATTERNS: readonly string[] = [
  'econnreset',
  'econnrefused',
  'enotfound',
  'epipe',
  'eai_again',
  'socket hang up',
  'fetch failed',
  'network error',
  'connection error',
  'terminated',
];

/** Substrings that mean a deadline elapsed. */
const TIMEOUT_PATTERNS: readonly string[] = [
  'etimedout',
  'timed out',
  'timeout',
  'deadline exceeded',
  'deadline_exceeded',
];

/** Substrings that mean the provider rejected the request itself. */
const INVALID_REQUEST_PATTERNS: readonly string[] = [
  'invalid_request_error',
  'invalid request',
  'bad request',
  'invalid argument',
  'invalid_argument',
];

/** Read a property off an unknown value without asserting anything about its shape. */
function field(source: unknown, key: string): unknown {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined;
  return (source as Record<string, unknown>)[key];
}

/** Whether `haystack` contains any of `patterns` (both compared lower-cased). */
function containsAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => haystack.includes(pattern));
}

/**
 * Every text an error carries that a classification may read: its message, its name, and the
 * nested provider payloads SDKs hang off `error`, `cause`, `body` and `response.data`. Bounded to
 * one nesting level per branch so a self-referential payload cannot spin.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number') parts.push(String(value));
  };
  push(field(error, 'message'));
  push(field(error, 'name'));
  push(field(error, 'code'));
  push(field(error, 'type'));
  if (typeof error === 'string') parts.push(error);
  for (const key of ['error', 'cause', 'body', 'data', 'response']) {
    const nested = field(error, key);
    if (typeof nested === 'string') {
      parts.push(nested);
      continue;
    }
    push(field(nested, 'message'));
    push(field(nested, 'type'));
    push(field(nested, 'code'));
    const inner = field(nested, 'error');
    push(field(inner, 'message'));
    push(field(inner, 'type'));
    push(field(inner, 'code'));
  }
  return parts.join('   ').toLowerCase();
}

/** The HTTP status an SDK error carries, wherever it hangs it. Undefined when there is none. */
function httpStatus(error: unknown): number | undefined {
  for (const holder of [error, field(error, 'response'), field(error, 'error')]) {
    for (const key of ['status', 'statusCode', 'code']) {
      const value = field(holder, key);
      if (typeof value === 'number' && value >= 100 && value < 600) return value;
      if (typeof value === 'string' && /^[1-5]\d{2}$/.test(value)) return Number(value);
    }
  }
  return undefined;
}

/** The `name` of an error, or `undefined` for anything that carries none. */
function errorName(error: unknown): string | undefined {
  const name = field(error, 'name');
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Whether a thrown value is a context overflow.
 *
 * The predicate is `ContextOverflowError.isInstance`, never `lc_error_code`: the code is set
 * asymmetrically across providers (Anthropic stamps both the class and the code, OpenAI only the
 * class), so keying on it silently misses most of where the typed class actually works. The
 * substring fallback then covers the providers LangChain does not type at all, and the case where
 * a reworded provider message drops the class.
 */
export function isContextOverflow(error: unknown): boolean {
  try {
    if (ContextOverflowError.isInstance(error)) return true;
  } catch {
    /* fail-soft: a dependency that stops exporting the predicate must not break classification */
  }
  if (errorName(error) === 'ContextOverflowError') return true;
  return containsAny(errorText(error), CONTEXT_OVERFLOW_PATTERNS);
}

/**
 * The exception feeder: classify a thrown value into the taxonomy.
 *
 * Order matters. The typed and named cases are decided first, because a context overflow is also an
 * HTTP 400 and an abort is also a `DOMException`; only once those are excluded does the status code
 * and then the prose get a say. Never throws: an unclassifiable value is `unknown`, which is a
 * recorded fact rather than a guess.
 */
export function classifyThrownTermination(error: unknown): GthTerminationClassification {
  try {
    const name = errorName(error);
    const text = errorText(error);
    const status = httpStatus(error);

    // Typed / named first — these are unambiguous and several of them also carry a status that
    // would classify them wrongly.
    if (isContextOverflow(error)) {
      return { category: 'context_overflow', detail: name ?? 'ContextOverflowError' };
    }
    if (name === 'AbortError' || name === 'ModelAbortError' || name === 'APIUserAbortError') {
      return { category: 'cancelled', detail: name };
    }
    if (name === 'GraphInterrupt') {
      return { category: 'suspended', detail: name };
    }
    if (name === 'ToolException') {
      return { category: 'tool_error', detail: name };
    }
    if (name === 'GraphRecursionError' || text.includes('recursion limit')) {
      return { category: 'recursion_limit', detail: name ?? 'recursion limit' };
    }
    if (name === 'TimeoutError' || name === 'APITimeoutError') {
      return { category: 'timeout', detail: name };
    }
    if (name === 'APIConnectionError') {
      return { category: 'network_error', detail: name };
    }

    // Status codes next: a number the provider set is stronger evidence than prose we matched.
    if (status === 429) return { category: 'rate_limited', detail: '429' };
    if (status === 401 || status === 403)
      return { category: 'auth_failed', detail: String(status) };
    if (status === 408 || status === 504) return { category: 'timeout', detail: String(status) };
    if (status !== undefined && status >= 500) {
      return { category: 'provider_error', detail: String(status) };
    }

    // Prose last, and in the order that keeps a specific signal from being eaten by a generic one:
    // "quota exceeded" is a rate limit before it is an invalid request, and an auth failure often
    // arrives as a 400 whose body says `invalid_grant`.
    if (containsAny(text, RATE_LIMIT_PATTERNS)) return { category: 'rate_limited' };
    if (containsAny(text, AUTH_PATTERNS)) return { category: 'auth_failed' };
    if (containsAny(text, TIMEOUT_PATTERNS)) return { category: 'timeout' };
    if (containsAny(text, NETWORK_PATTERNS)) return { category: 'network_error' };
    if (containsAny(text, PROVIDER_ERROR_PATTERNS)) return { category: 'provider_error' };
    if (status === 400 || containsAny(text, INVALID_REQUEST_PATTERNS)) {
      return { category: 'invalid_request', detail: status === undefined ? undefined : '400' };
    }

    return { category: 'unknown', ...(name === undefined ? {} : { detail: name }) };
  } catch {
    // Classification must never be the thing that breaks a run that was already failing.
    return { category: 'unknown' };
  }
}

/**
 * The property a reason is carried on when it rides a thrown error.
 *
 * A run that ends by throwing crosses layers the runner does not own, and the message is not the
 * carrier — that is the whole defect this taxonomy exists to fix. Attaching the value to the error
 * lets any catcher upstream read the classification without re-deriving it from prose.
 */
const TERMINATION_REASON_KEY = 'gthTerminationReason';

/**
 * Attach a reason to a thrown value and return it, so a `throw` site reads as one expression.
 *
 * Non-enumerable, so the reason never widens what an error serialises to (a logged or
 * JSON-stringified error keeps exactly the shape it had), and first-write-wins so a re-throw
 * through an outer wrapper cannot overwrite the inner, truer classification. Fail-soft: a frozen or
 * primitive throw value is returned unchanged rather than turning a failure into a different one.
 */
export function attachTerminationReason<T>(error: T, reason: GthTerminationReason): T {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
    if (field(error, TERMINATION_REASON_KEY) !== undefined) return error;
    Object.defineProperty(error, TERMINATION_REASON_KEY, {
      value: reason,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    /* fail-soft */
  }
  return error;
}

/** The reason attached to a thrown value, following one `cause` link. Undefined when none is. */
export function terminationReasonOf(error: unknown): GthTerminationReason | undefined {
  const own = field(error, TERMINATION_REASON_KEY);
  if (own && typeof own === 'object') return own as GthTerminationReason;
  const cause = field(error, 'cause');
  const inherited = field(cause, TERMINATION_REASON_KEY);
  if (inherited && typeof inherited === 'object') return inherited as GthTerminationReason;
  return undefined;
}
