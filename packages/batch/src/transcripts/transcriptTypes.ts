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
 * not describe a completed run (truncated, an error result, not the format it reads); the runner
 * turns the throw into a harness error for that case, never an empty answer that grades as a FAIL.
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
}

/**
 * Decode one run's stdout. Throws when the run did not complete; the message becomes the case's
 * harness-error reason, so it should say what was missing.
 *
 * A custom decoder is a module whose default export has this shape, named by path in the suite's
 * `target.transcript`.
 */
export type TranscriptDecoder = (stdout: string) => DecodedTranscript;
