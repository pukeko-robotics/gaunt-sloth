/**
 * BATCH-57 — the transcript-decoder seam of the `command` eval target.
 *
 * A command target starts a command-line agent once per case and hands everything it printed to
 * stdout to a decoder. The decoder's whole job is to say what the agent answered, which tools it
 * called with which arguments, and what each call returned. Everything after that — capping the
 * payloads at `toolResultCaptureMaxBytes`, deciding whether arguments are kept, deriving the
 * `tools` name list — is the runner's, so the gth-agent target and every decoder are capped and
 * shaped in exactly one place and a custom decoder cannot get it subtly different.
 *
 * A decoder is a plain synchronous function of the whole stdout. It THROWS when the transcript does
 * not describe a run that reached its end (truncated, garbled, no terminal result, not the format it
 * reads); the runner turns the throw into a harness error for that case, never an empty answer that
 * grades as a FAIL. **A throw is a harness error whatever the suite's `grade_when` lists**: output
 * that never reached a terminal result says nothing about how the agent behaves.
 *
 * ## How the run ended (BATCH-62)
 *
 * A decoder that DID reach a terminal result which says the run stopped early (Claude Code's
 * `error_max_turns`, for one) returns the transcript it decoded with {@link
 * DecodedTranscript.outcome} set to the agent's own name for that ending, and
 * {@link DecodedTranscript.outcomeReason} saying why, instead of throwing. The runner then decides:
 * an outcome the case's effective `grade_when` lists is graded on that transcript, whatever the exit
 * code; any other is the same harness error a throw would be, with `outcomeReason` as its reason.
 *
 * An absent `outcome` means `success`, so a custom decoder written before the field existed keeps
 * working unchanged: it throws on an unfinished run, as it always did, and every run it returns is a
 * finished one. Returning an outcome is how a decoder opts its own early endings in to being
 * gradeable at all; the suite author still has to list them.
 *
 * `outcome` is part of the public contract for custom decoders (`docs/COMMANDS.md`, the command
 * target). The runner validates it: a value that is set but is not a non-empty string is a harness
 * error naming the decoder, never read as `success`. A non-string `outcomeReason` is ignored in
 * favour of a generic sentence.
 *
 * @module
 */

/** One tool call the agent requested, in the order it requested them. */
export interface DecodedToolCall {
  /** The tool's name, as the agent called it. */
  name: string;
  /** The call's id, when the transcript carries one. */
  id?: string;
  /** The arguments as JSON text, uncapped. */
  args: string;
}

/** One tool result the agent received, in the order it received them. */
export interface DecodedToolResult {
  /** The tool that produced it — looked up from the call the result answers. */
  name: string;
  /** `true` iff the transcript marked the result as an error. */
  isError: boolean;
  /** The payload as the agent observed it, as text (non-string payloads JSON-stringified), uncapped. */
  content?: string;
}

/** What a decoder makes of one completed run's stdout. */
export interface DecodedTranscript {
  /** The agent's final answer. */
  answer: string;
  toolCalls: DecodedToolCall[];
  toolResults: DecodedToolResult[];
  /** Total input tokens, when the transcript reports usage. */
  tokensInput?: number;
  /** Total output tokens, when the transcript reports usage. */
  tokensOutput?: number;
  /**
   * BATCH-62 — how the run ended, in the agent's own words (Claude Code's result `subtype`, such as
   * `error_max_turns`). Absent, or `success`, means the run finished. Any other value is a run that
   * reached a terminal result but stopped early; it is graded only when the case's `grade_when`
   * lists it, and is a harness error otherwise. Never an empty string.
   */
  outcome?: string;
  /**
   * BATCH-62 — why the run did not end in `success`, as a sentence: the harness-error reason when
   * {@link outcome} is not listed, so it reads exactly as the throw it replaces. Ignored when
   * {@link outcome} is absent or `success`; the runner says `the run ended with outcome "<outcome>"`
   * when a decoder sets an outcome without one.
   */
  outcomeReason?: string;
}

/**
 * Decode one run's stdout. Throws when the run did not reach a terminal result; the message becomes
 * the case's harness-error reason, so it should say what was missing. A run that reached one but
 * stopped early is returned with {@link DecodedTranscript.outcome} set (see the module docblock).
 *
 * A custom decoder is a module whose default export has this shape, named by path in the suite's
 * `target.transcript`.
 */
export type TranscriptDecoder = (stdout: string) => DecodedTranscript;
