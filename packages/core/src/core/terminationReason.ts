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
import { readProviderErrorPayload } from '#src/core/providerErrorNotice.js';

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
  /**
   * [[EXT-204]] — the model's reply was cut off before it finished (no answer text, no tool call and
   * no finish reason), and the one retry was cut off too.
   */
  | 'stream_cut'
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
  /**
   * The tool-approval interrupt drain gave up: the graph re-suspended on a gated tool call more
   * times in one turn than the drain loop is willing to resume, so the RUNTIME ended the turn.
   *
   * Deliberately not `recursion_limit`, which states that the graph hit *its* recursion limit — a
   * different bound, owned by LangGraph, with a different knob. Reporting one for the other would
   * be the same false-category defect this taxonomy exists to remove, and `site` is what separates
   * the two surfaces this bound has.
   */
  | 'interrupt_drain_guard'
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
  /**
   * [[EXT-203]] — the streamed turn was empty and the non-streaming fallback was NOT spent,
   * because the thread already ends with the model's own turn and re-sending it would call the
   * provider on a history ending with a model message.
   */
  | 'runner.empty-stream'
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
  /**
   * [[EXT-160]] — the turn overflowed the context and compaction could not make it smaller: there
   * was nothing left worth folding, the summary could not be produced, or the agent exposes no
   * conversation state to rewrite. Distinct from the two wrappers above because the category they
   * would report is the same and the *remedy* is not: this one says the automatic remedy was tried
   * and had nothing left to give, so the next step is a human's.
   */
  | 'runner.overflow-compact'
  /**
   * [[EXT-160]] — the turn overflowed AGAIN on the retry that followed a successful compaction.
   * One retry is the whole budget: a second overflow after the conversation was already folded is
   * evidence that the prompt is too large for reasons compaction cannot reach (one enormous tool
   * result, a window smaller than the system prompt), and a second compaction would fold the tail
   * it just kept and try the same thing again.
   */
  | 'runner.overflow-compact-exhausted'
  /** The string path's tool-approval drain ran out of resume rounds. */
  | 'runner.interrupt-guard-exhausted'
  /** `GthAgentRunner.processMessagesWithEvents` drained its stream to the end. */
  | 'runner.events-completed'
  /** The typed-event turn ended having yielded no answer text at all. */
  | 'runner.events-empty'
  /** The typed-event turn ended because its signal was aborted. */
  | 'runner.events-cancelled'
  /** The typed-event turn threw. */
  | 'runner.events-error'
  /** The consumer stopped consuming the typed-event turn before it ended. */
  | 'runner.events-abandoned'
  /** The typed-event path's tool-approval drain ran out of resume rounds. */
  | 'runner.events-interrupt-guard-exhausted'
  /** The metadata reader fired on the non-streaming `invoke` path. */
  | 'agent.invoke-stop-metadata'
  /** The metadata reader fired on the string-streaming path. */
  | 'agent.stream-stop-metadata'
  /** The metadata reader fired on the typed-event path. */
  | 'agent.events-stop-metadata'
  /** A `ToolException` was turned into the turn's answer on the `invoke` path. */
  | 'agent.invoke-tool-exception'
  /**
   * [[EXT-184]] — the non-streaming `invoke` path ended on Esc / an abort.
   *
   * Its own site rather than sharing `agent.stream-cancelled`, because the two arms of the runner's
   * `streamOutput` branch are exactly what a reader of this reason needs told apart: they cancel
   * through different machinery and leave the turn holding different things (partial content on one
   * arm, a notice on the other).
   */
  | 'agent.invoke-cancelled'
  /** The string-streaming path ended on Esc / an abort. */
  | 'agent.stream-cancelled'
  /** `streamWithEvents` ended on a suspend or an abort. */
  | 'agent.events-ended'
  /** `streamWithEventsResume` ended on a suspend or an abort. */
  | 'agent.events-resume-ended'
  /** The tool-error budget's `jumpTo: 'end'`. */
  | 'middleware.tool-error-budget'
  /** The tool-loop guard's `jumpTo: 'end'`. */
  | 'middleware.tool-loop-guard'
  /**
   * A model call carrying an injected binary attachment was rejected by the provider, and the
   * binary-content-injection middleware added an explanation to the error's text.
   *
   * The site exists because that middleware is a WRITER of the text this module's classifier
   * reads. The note carries a **filename**, which is user data nobody there controls, so the
   * middleware classifies the failure and commits the value BEFORE it touches the message: it is
   * its own classifier's caller, and reading `holiday-timeout.pdf` back out of a note it had
   * already written would answer `timeout` for a rejection. Committing first is what keeps that
   * order honest; {@link classifyThrownTermination} then declines to read the message at all for
   * anyone downstream. `attachTerminationReason` is first-write-wins, so an inner site that
   * already classified the same failure still keeps it.
   */
  | 'middleware.binary-attachment-rejected'
  /**
   * [[EXT-204]] — the cut-stream retry middleware: the model's reply was cut off before it finished,
   * it was retried once inside the same model call, and the retry was cut off as well.
   */
  | 'middleware.stream-cut-retry';

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

/**
 * The retry posture of a category — the two facts, plus the remedy the second one refers to.
 *
 * **Posture is per-CATEGORY, so anything acting on a reason must read its `site` as well.** One
 * table decides the posture precisely so no site can invent its own, and the price of that is that
 * the table cannot know how far a given site already got. The standing example is
 * `empty_response`, which is `retryableAsIs: true` because an empty turn usually is worth asking
 * again — yet `runner.empty-after-fallback` is reached only *because* that as-is retry was already
 * spent, while `runner.events-empty` is reached with it never spent at all. A consumer reading the
 * posture flags alone would retry the first of those a second time.
 */
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
 *
 * ## THIS TABLE IS ADVISORY. `GTH_MAX_RETRIES` IS THE ENFORCEMENT.
 *
 * Read that before using a row to predict what the runtime will do. The table's job is to let this
 * project *explain* a termination — it is what turns a category into a user-facing sentence such as
 * "Sending the same request again may work", and what a remedy-aware caller consults before
 * deciding whether a changed request is worth sending. It is not consulted by anything that
 * actually re-sends a request.
 *
 * The retry loop lives upstream, in `@langchain/core`'s `AsyncCaller`, which decides retryability
 * from the error it caught — a response status, a rate-limit classification, a transport match —
 * with no knowledge of this taxonomy. What this project owns there is the ceiling: one stated count
 * (`core/retryPolicy.ts`), passed to every model we construct.
 *
 * ### Why it is left advisory rather than made to drive the retry
 *
 * Driving the decision from this table would mean owning the retry loop: intercepting each failure
 * before upstream's handler, mapping it to a category, and re-implementing backoff, `retry-after`
 * honouring and concurrency. That is a large replacement of working upstream machinery, and the
 * argument for it is weak, because **the two classifications already agree**. Measured against the
 * installed `AsyncCaller`: the statuses it refuses to retry are the `invalid_request` / `auth_failed`
 * rows; it splits a 429 into quota-exhausted (stop) and wait/capacity (retry after a delay), which
 * is the `rate_limited` row's back-off; and everything else, transport and provider faults included,
 * falls through to be retried — the `network_error`, `provider_error` and `timeout` rows.
 *
 * So one layer describes the posture and another enforces a count, and they do not contradict each
 * other. The honest move is to say which is which here, rather than to leave a reader inferring that
 * editing a row changes what gets re-sent. **Editing a row changes what the user is TOLD, not what
 * the runtime DOES.** A change to what it does is a change to the count, or an upstream change.
 *
 * ### The two places they do not agree, both upstream and both narrowing
 *
 * `ECONNABORTED` is rethrown by upstream's failed-attempt handler rather than retried, so a
 * connection aborted mid-request contradicts the `network_error` row; and transport is recognised by
 * matching the error message against a fixed list of literals, so a wording change upstream would
 * silently reclassify it. Both are recorded in full on `GTH_MAX_RETRIES`. Neither is reachable from
 * this file — they are named here only so a reader comparing the row to observed behaviour finds the
 * explanation instead of assuming the row is wrong.
 */
const POSTURE: Readonly<Record<GthTerminationCategory, GthTerminationPosture>> = {
  // Nothing went wrong; there is nothing to retry.
  completed: { retryableAsIs: false, retryableAfterRemedy: false },
  // The one cause the runtime already retries as-is, and it is right to: an empty turn is usually
  // transient. A model that keeps returning nothing needs a different model, not another attempt.
  empty_response: { retryableAsIs: true, retryableAfterRemedy: true, remedy: 'change-model' },
  // A stream cut off before its final chunk is the provider's transient fault, not the model's
  // answer. The one as-is retry was already spent inside the model call, so the advice is to wait
  // and send it again, as for a provider error.
  stream_cut: { retryableAsIs: true, retryableAfterRemedy: true, remedy: 'back-off' },
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
  // The same turn re-suspends the same way, so repeating it exhausts the same bound. Asking for
  // less gated work in one turn is what gets under it.
  interrupt_drain_guard: {
    retryableAsIs: false,
    retryableAfterRemedy: true,
    remedy: 'change-request',
  },
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

/**
 * [[EXT-159]] — one observation of what the provider said about why a model message stopped.
 *
 * Recorded per finished model message, on every path, whether or not the provider said anything.
 * No `finish_reason` was written to any log anywhere before this, so the artifact a maintainer
 * reaches for first could not answer the question it exists to answer — and a turn where the
 * provider stayed silent looked exactly like one that ended normally.
 *
 * **The absence is the observation.** `token: null` states that the message carried no stop or
 * finish reason at all; it is never a stand-in for one, and no observation is invented for a
 * message that was never seen.
 */
export interface GthFinishReasonObservation {
  /** When the message was observed, as an ISO instant with a zone. */
  at: string;
  /** Which of the agent's three paths produced the message. */
  path: 'invoke' | 'stream' | 'events';
  /** The provider's raw token, lower-cased — or `null` when the message carried none. */
  token: string | null;
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
  // [[EXT-163]] Load-bearing for groq. Measured 2026-09-10, live groq, `allam-2-7b`: the overflow
  // 400 body was `{"error":{"message":"Please reduce the length of the messages or completion.",
  // "type":"invalid_request_error","param":"messages"}}`, with no `code` on that response. Groq is
  // not uniform, though: public records of the same endpoint show this sentence together with
  // `code: context_length_exceeded`, so the absent code is a property of the response measured,
  // not of groq. Both shapes classify — a coded one also matches 'context_length_exceeded' above,
  // since `errorText` collects the nested `code`; an uncoded one matches only this arm. Dropping
  // this arm as redundant with 'maximum context length' — which OpenAI's message, the sentence's
  // source, also hits — turns an uncoded groq overflow into an `invalid_request`, never compacted.
  'reduce the length of the messages',
  'request too large',
  // [[EXT-162]] Load-bearing for google, and for both provider ids. Measured 2026-09-12, live AI
  // Studio through `@langchain/google` 0.2.3, on two models with different windows
  // (`gemini-3.8-flash`, 1048576 tokens, and `gemini-2.5-flash-image`, 32768): an oversized input
  // is an HTTP 400 thrown as that package's own `RequestError`, and the whole body is
  // `{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens
  // allowed (1048576).","status":"INVALID_ARGUMENT"}}`. The package maps no context overflow at
  // all — it stamps `ContextOverflowError` on nothing — so without this arm the 400 fell to
  // `invalid_request` and the compact-and-retry seam never saw an overflow it could act on.
  //
  // **Nothing structural can carry it.** `code: 400` and `status: 'INVALID_ARGUMENT'` are byte for
  // byte what a rejected API key returns from the same endpoint, so the prose is the only carrier —
  // the conclusion [[EXT-163]] reached for groq, reached again here from the opposite direction.
  //
  // **The arm is the tail of the sentence rather than its head, deliberately.** 'input token count
  // exceeds' matches the measured bytes just as well and stops matching the moment the count is
  // rendered inline — `The input token count (1246756) exceeds the maximum …` — a gap the head
  // cannot span and this arm still covers.
  //
  // **VERTEX IS MEASURED, and this one arm carries it too — no second arm is needed.** Live on
  // 2026-09-12 through the same package: the envelope is identical by construction (one
  // `apiClient.fetch(...)`, one `throw await RequestError.fromResponse(response)`, `buildUrl` the
  // only platform branch), and **the wording differs in the parentheses and nothing else** —
  // `The input token count exceeds the maximum number of tokens allowed 1048576.` against AI
  // Studio's `... allowed (1048576).` So matching the tail rather than the head is what spans the
  // two PLATFORMS as well as the inline-count case above; an arm reaching into the open paren
  // would have missed Vertex entirely. Confirmed on `gemini-3.8-flash` and `gemini-3.5-flash-lite`
  // on Vertex, on both transports.
  //
  // The one Vertex case this cannot reach is `gemini-2.5-flash-image` while STREAMING, which
  // answers an oversized input `Request contains an invalid argument.` with no token-count prose
  // anywhere in the body. Neither prose nor structure can close it — `code: 400` /
  // `status: 'INVALID_ARGUMENT'` are byte for byte a rejected key — and matching 'invalid
  // argument' would make every malformed request an overflow.
  //
  // **[[EXT-176]] RULED THAT CASE NOT WORTH CLOSING, and this is the record of why.** Nothing was
  // shipped for it; the negative control in `googleContextOverflow.spec.ts` is permanent rather
  // than provisional. Re-measured live 2026-09-18 against Vertex project
  // `gen-lang-client-0307038741`, location `global`, through this repo's own `providers/vertexai.js`
  // — every URL confirmed to be `aiplatform.googleapis.com/...`, since an ambient `GOOGLE_API_KEY`
  // outranks ADC (CFG-58) and would otherwise have measured express mode instead:
  //
  // | platform   | model                   | transport | `error.message`                                      | classified |
  // |------------|-------------------------|-----------|------------------------------------------------------|------------|
  // | Vertex     | `gemini-2.5-flash-image`| stream    | `Request contains an invalid argument.`               | NO         |
  // | Vertex     | `gemini-2.5-flash-image`| invoke    | `...allowed 32768.`                                   | yes        |
  // | Vertex     | `gemini-3.5-flash-lite` | stream    | `...allowed 1048576.`                                 | yes        |
  // | AI Studio  | `gemini-2.5-flash-image`| stream    | `...allowed (32768).`                                 | yes        |
  //
  // **IT IS AN INTERACTION OF PLATFORM AND MODEL AND TRANSPORT, and that is the part everyone gets
  // wrong on first reading.** "Vertex streaming loses the overflow message" is FALSE — row 3 streams
  // the detailed sentence on the same platform. "The image model cannot report a count while
  // streaming" is FALSE — row 4 does exactly that on AI Studio. "The model never reports a count" is
  // FALSE — row 2 reports it on the same platform with the same payload. Only all three together
  // reach the generic sentence, so a future arm must not generalise from any one of them.
  //
  // **Why it was not worth closing: nothing a `gth init` can produce lands in that cell.** `vertexai`
  // carries `discovery: { kind: 'none' }`, so `buildModelList` returns only the curated
  // `preferredModels`. Its head, `gemini-3.8-flash`, classifies on both transports; the Gemini 4
  // ids after it (hydrogen, argon, neon, carbon) have NOT been measured against an oversized input,
  // so whether they reach the generic sentence while streaming is unknown. The first-run dialog offers free-text model entry ONLY when that list comes back
  // empty, which for this provider it never does, and a bare `init vertexai` omits `model` entirely
  // so it resolves through `getCuratedFallbackModel('vertexai')` to `gemini-3.8-flash`. Reaching the
  // affected cell takes a hand-edited config naming an image-generation model as an agentic chat
  // model. The consequence there is a worse DIAGNOSIS — `invalid_request` instead of
  // `context_overflow`, so the [[EXT-160]] seam does not offer to compact — not lost data.
  //
  // **Why a `:countTokens` pre-flight was not the answer HERE.** A token count is only actionable
  // against a window, and when the window is known the [[EXT-161]] preventive guard
  // (`createContextGuardMiddleware`, `beforeModel`, compaction on by default) has already run before
  // the call — read live from `https://models.dev/api.json` on 2026-09-18, its `google-vertex` slice
  // carries this model at `{"context":32768}`, so that guard is armed for the affected cell too.
  // (That is a reading off a catalog that refreshes, not a static property of the checkout: re-read
  // it rather than assuming it, the way [[EXT-189]]'s table above dates its own measurements.)
  // When the window is NOT known, a count has nothing to compare
  // itself to and cannot classify either. What a real count WOULD buy is accuracy against
  // `ESTIMATE_CHARS_PER_TOKEN`, whose pessimistic 3.5 can still read low on dense content — the
  // [[EXT-189]] table above measures a 2.13× miss — and that is a GENERIC improvement to the
  // estimator, for every provider and every model, not a classification arm for one model. It
  // belongs with [[EXT-160]]/[[EXT-161]] if anyone wants it, and this ruling does not argue against
  // it there; it argues against paying a per-turn network round trip on the hot path to improve one
  // hand-configured cell's diagnosis.
  //
  // **Why a non-streaming re-issue was not the answer.** It has to be gated on something, and the
  // only gate available is `category === 'invalid_request'` plus a 400 — which by this hole's own
  // premise is exactly the population that CANNOT be narrowed: bad tool schemas, unsupported
  // parameters, malformed payloads, and any auth failure whose prose misses the auth arms. So the
  // second round trip is paid across all of them to serve one cell. The billing edge runs the
  // opposite way to intuition: a re-issue genuinely over the window is rejected free, and it is the
  // re-issue that SUCCEEDS that costs — a full generation billed and then discarded, because the
  // seam only ever wanted the error message. On an image model that is a billed image.
  'exceeds the maximum number of tokens allowed',
  // [[EXT-164]] Load-bearing for openrouter, and for ONE of its upstreams. Measured 2026-09-17,
  // live OpenRouter through `@langchain/openrouter` 0.4.13, three deliberately-oversized requests:
  //
  // | routed to      | via id                       | `metadata.provider_error_code` | upstream sentence in `metadata.raw`                 |
  // |----------------|------------------------------|--------------------------------|-----------------------------------------------------|
  // | OpenAI         | `openai/gpt-3.5-turbo`       | `context_length_exceeded`      | "This model's maximum context length is 16385 …"     |
  // | Anthropic      | `anthropic/claude-haiku-4.5` | ABSENT                         | "prompt is too long: 254245 tokens > 200000 maximum" |
  // | Amazon Bedrock | `anthropic/claude-3-haiku`   | ABSENT                         | "Input is too long for requested model."             |
  //
  // The first two already classified — through `context_length_exceeded` and `prompt is too long`
  // respectively. **The Bedrock one matched nothing** and fell to `invalid_request`, which the
  // compact-and-retry seam never acts on. That is the gap this arm closes, and it is the node's
  // point made by the router itself: the SAME OpenRouter id family produced three different
  // sentences because three different upstreams wrote them.
  //
  // **Deliberately `'input is too long for'` rather than the bare `'input is too long'`.**
  // `isContextOverflow` is consulted BEFORE the `ToolException` arm in
  // {@link classifyThrownTermination}, so the shorter form would re-route a tool's own
  // input-length validation message ("Input is too long, maximum 500 characters") to history
  // compaction. Requiring the continuation keeps the arm on the sentence a *model* endpoint writes
  // while still spanning its rewordings ("… for this model", "… for the requested model"). The cost
  // is a hypothetical inline count ("Input is too long (254245 tokens) for requested model"), which
  // no measured response renders.
  'input is too long for',
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
  // [[EXT-164]] **A router's own message says nothing, so read the envelope it puts the upstream
  // error in.** OpenRouter's top-level fields for every provider-side failure are
  // `message: 'Provider returned error'` and `code: 400` — byte for byte the same for an overflow,
  // a content filter and a malformed tool schema. Everything that distinguishes them is in
  // `metadata`: the upstream's verbatim body in `raw`, and OpenRouter's own
  // `provider_error_code` where the upstream gave it one.
  //
  // It reaches the loop above today only because `OpenRouterError.fromResponse` appends
  // ` | metadata: <json>` to the message — an upstream FORMATTING choice that
  // `providerErrorNotice.ts` exists to undo on screen and argues against. If upstream stops doing
  // it, every OpenRouter overflow silently becomes `invalid_request` and is never compacted.
  // Reading the fields where they actually live is what makes the classification independent of
  // that string. `openrouterContextOverflow.spec.ts` carries the canary for the day it changes.
  //
  // The reader is `providerErrorNotice`'s rather than a second copy: it is already duck-typed on
  // the shape (so it is not an import of a provider package), already walks one `cause` hop the
  // way this module does, and a copy is exactly what would keep this green after that one stopped
  // recognising the payload.
  const providerPayload = readProviderErrorPayload(error);
  push(providerPayload?.providerText);
  push(providerPayload?.providerErrorCode);
  // The separator is deliberately not a plain space: the prose patterns below are multi-word
  // English, and joining two adjacent fragments with a space lets a pattern match ACROSS them —
  // a fragment ending in "rate" beside one starting with "limit" would read as a rate limit.
  // A newline cannot occur mid-pattern, so it breaks that adjacency without hiding anything.
  return parts.join(' \n ').toLowerCase();
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
 * Which context-overflow arms `error`'s text actually matches, in list order.
 *
 * `isContextOverflow` answers yes or no. That is not enough for a caller whose job is to find out
 * whether one *particular* arm is still doing its work, because several arms reach the same answer
 * and two of them reach it from opposite causes: a groq context overflow is carried by the prose
 * arm `reduce the length of the messages`, while a groq TPM rate rejection is carried by the
 * adjacent `request too large`. A check that reads only the resulting category therefore passes for
 * the wrong reason at exactly the moment the first arm stops matching. Naming the arms is what
 * separates them.
 *
 * Read-only, and no classification consults it — it reports what the same pattern list and the same
 * text reader already decide. The reason it lives here rather than in the caller is that a caller
 * outside this module cannot reproduce the answer without copying the list, and a copy is precisely
 * what would keep such a check green after the production arm had been deleted.
 */
export function contextOverflowPatternsMatching(error: unknown): readonly string[] {
  const text = errorText(error);
  return CONTEXT_OVERFLOW_PATTERNS.filter((pattern) => text.includes(pattern));
}

/**
 * The exception feeder: classify a thrown value into the taxonomy.
 *
 * **[[CFG-73]] A committed reason outranks everything else, prose included.** When
 * {@link terminationReasonOf} answers for the thrown value, that answer is returned and no text is
 * read at all. The site that attached it watched the failure happen, and this module's whole
 * premise is that the message is not the carrier — so a feeder that reads the message anyway
 * exempts itself from the rule it states for every consumer.
 *
 * The exemption was user-visible. A message is the one part of an error that untrusted data reaches:
 * the binary-attachment middleware interpolates a **filename** into a provider rejection so the user
 * can see which file was refused, and `api-timeout-investigation.pdf` or `contract - terminated.pdf`
 * then read back out of the prose as a timeout or a dropped connection. Both are retryable postures,
 * so the user is told to send again a request the provider will refuse identically every time, and a
 * name matching an overflow pattern sends the runner off to compact the history first. Sanitising
 * the text against the pattern lists would only enumerate today's patterns and go stale the next
 * time one grows; preferring the committed value cannot go stale, because it does not depend on what
 * the text says.
 *
 * **Everything below is the fallback for a value nobody classified**, and it is unchanged. Order
 * still matters there. The typed and named cases are decided first, because a context overflow is
 * also an HTTP 400 and an abort is also a `DOMException`; only once those are excluded does the
 * status code and then the prose get a say.
 *
 * **The prose arms stay ahead of the invalid-request arm, and `status === 400` stays behind them.**
 * 400 is a bucket rather than a cause — providers put a bad API key, an expired grant and an
 * exhausted quota in it — so the specific arms are what recover the cause, and each of the
 * categories they recover names a remedy `invalid_request` has none of. Lifting the status above
 * them would trade `auth_failed` and its `fix-credentials` for a category that offers the user
 * nothing, and it would not close the hazard either: any permutation of a substring matcher leaves
 * some hostile substring that flips some category. Untrusted text reaching the matcher at all is the
 * defect, and the committed reason is what closes it.
 *
 * Never throws: an unclassifiable value is `unknown`, which is a recorded fact rather than a guess.
 */
export function classifyThrownTermination(error: unknown): GthTerminationClassification {
  try {
    // A category already committed by a site that saw the failure. Guarded on the shape rather
    // than trusted, so a foreign value parked on the property falls through to the fallback
    // instead of becoming a category nothing in the taxonomy defines.
    const committed = terminationReasonOf(error);
    if (typeof committed?.category === 'string' && committed.category.length > 0) {
      return {
        category: committed.category,
        ...(committed.provider === undefined ? {} : { provider: committed.provider }),
        ...(committed.detail === undefined ? {} : { detail: committed.detail }),
      };
    }

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
      // `detail` is the raw token the classification was made from, so it states the status the
      // response ACTUALLY had. A 402 or 409 whose prose matches the patterns reaches this branch
      // too (it is past the 429/401/403/408/5xx arms), and stamping a flat '400' on one would put
      // a false statement in the field that exists to record what was seen.
      return {
        category: 'invalid_request',
        detail: status === undefined ? undefined : String(status),
      };
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

/**
 * [[EXT-160]] — **replace** the reason attached to a thrown value.
 *
 * {@link attachTerminationReason} is first-write-wins, which is right for the nested wrappers it
 * was built for: the inner site saw the failure first and is the truer classification. This is the
 * one case that legitimately overwrites, and it is not an exception to that rule but an instance of
 * it — the compact-and-retry seam has seen the overflow happen TWICE, and the wrapper that
 * classified the second one only ever saw one of them. Without this the runner's own field and the
 * reason riding on the error would disagree about the same failure, which is precisely what
 * `classifyThrownAt` exists to prevent.
 */
export function replaceTerminationReason<T>(error: T, reason: GthTerminationReason): T {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
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
