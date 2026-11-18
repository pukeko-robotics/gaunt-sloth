/**
 * BATCH-57 — the built-in `claude-stream-json` decoder: Claude Code's
 * `claude -p --output-format stream-json --verbose` output, one JSON object per line.
 *
 * Built from a real captured transcript (`spec/fixtures/claude-stream-json/capture.jsonl`), not
 * from a remembered schema. The lines it reads, and only these:
 *
 * - `{"type":"assistant","message":{"content":[…]}}` — each `tool_use` block is one requested call
 *   (`id`, `name`, `input`). Claude Code prints one line per content block, so parallel calls arrive
 *   as several lines that share one message id; calls are therefore keyed by the BLOCK's `id`, and
 *   a repeated block id is recorded once. The arguments are `JSON.stringify(input)`, the same
 *   derivation the gth-agent target applies to a whole message's `tool_calls`. `wire_tool_inputs`
 *   repeats the input and is not read.
 * - `{"type":"user","message":{"content":[…]}}` — each `tool_result` block is one result. Its
 *   `tool_use_id` names the call it answers, and the call's name comes from that `tool_use`, so a
 *   parallel round grades correctly whatever order the results arrive in. `is_error` is absent on
 *   a successful result in the capture, so absent means `false`. The payload is the block's
 *   `content` — what the model observed — passed through when it is a string and JSON-stringified
 *   otherwise (Claude Code sends block arrays for some tools), which is core's
 *   `toolResultContentText` rule. The line's `tool_use_result` is Claude Code's own richer record,
 *   which the model never saw, and is not read.
 * - `{"type":"result",…}` — the terminal line. It is REQUIRED, the way the AG-UI decoder requires
 *   `RUN_FINISHED`: a transcript without one was cut off, and grading a cut-off run as a complete
 *   one would turn a crash into an assertion failure.
 *
 * Everything else — `system` lines, `thinking` and `text` blocks, unknown line types, and lines that
 * are not JSON at all — is skipped, so a newer Claude Code that adds a line type still decodes.
 *
 * ## Decisions
 *
 * **The answer is the `result` line's `result` string.** In the capture it is byte-identical to the
 * last assistant `text` block. It is the CLI's own statement of the final answer, it is what
 * `--output-format json` prints alone, and it does not depend on how a multi-block final message
 * happens to be split across lines. Only when a successful result carries no `result` string does
 * the decoder fall back to the last assistant text block.
 *
 * **A non-success result is a failed run, not a graded one.** `subtype` other than `success` (such
 * as `error_max_turns` or `error_during_execution`), or `is_error: true`, throws with the subtype in
 * the message, and the runner grades the case as a harness error. The agent did not finish, so its
 * partial trace is not evidence of how it behaves, and an assertion failing against it would read
 * as the agent's choice when it was the harness's limit.
 *
 * **Subagent events are included.** A line with a non-null `parent_tool_use_id` belongs to a
 * subagent the main agent started (the `Task`/`Agent` tool), and its calls are part of the trace.
 * Leaving them out would let `must_not_call: [Bash]` pass while a subagent ran Bash, a false green
 * that is worse than a strict trace. Tool-use ids are unique across the session, so pairing is
 * unaffected.
 *
 * **Tokens are the `result` line's `usage`.** Input is `input_tokens` plus both cache counts,
 * because Anthropic reports cached prompt tokens outside `input_tokens` (the capture's
 * `input_tokens` is 4 for a 99k-token run); output is `output_tokens`.
 *
 * A result for a call the transcript never showed throws: there is no honest name to file it under,
 * and `must_error` keyed on a guessed name could pass or fail for the wrong reason.
 *
 * @module
 */
import type {
  DecodedToolCall,
  DecodedToolResult,
  TranscriptDecoder,
} from '#src/transcripts/transcriptTypes.js';

/** The built-in name this decoder registers under. */
export const CLAUDE_STREAM_JSON = 'claude-stream-json';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(line: JsonObject): JsonObject[] {
  const message = line.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
}

function payloadText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === undefined) return undefined;
  try {
    return JSON.stringify(content);
  } catch {
    return undefined;
  }
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Decode Claude Code `stream-json` output. See the module docblock for what is read and why. */
export const decodeClaudeStreamJson: TranscriptDecoder = (stdout) => {
  const toolCalls: DecodedToolCall[] = [];
  const toolResults: DecodedToolResult[] = [];
  const callNames = new Map<string, string>();
  let lastText: string | undefined;
  let result: JsonObject | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(line)) continue;

    if (line.type === 'assistant') {
      for (const block of contentBlocks(line)) {
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
          const id = typeof block.id === 'string' && block.id ? block.id : undefined;
          if (id && callNames.has(id)) continue;
          if (id) callNames.set(id, block.name);
          toolCalls.push({
            name: block.name,
            ...(id ? { id } : {}),
            args: payloadText(block.input ?? {}) ?? '{}',
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          lastText = block.text;
        }
      }
    } else if (line.type === 'user') {
      for (const block of contentBlocks(line)) {
        if (block.type !== 'tool_result') continue;
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const name = callNames.get(callId);
        if (name === undefined) {
          throw new Error(
            `a tool_result answers tool_use_id "${callId}", which no earlier tool_use in the ` +
              'transcript declared, so the result cannot be attributed to a tool.'
          );
        }
        const content = payloadText(block.content);
        toolResults.push({
          name,
          isError: block.is_error === true,
          ...(content !== undefined ? { content } : {}),
        });
      }
    } else if (line.type === 'result') {
      result = line;
    }
  }

  if (result === undefined) {
    throw new Error(
      'the transcript has no final "result" line, so the run did not complete (it was cut off, ' +
        'or the command does not print `--output-format stream-json --verbose`).'
    );
  }
  const subtype = typeof result.subtype === 'string' ? result.subtype : '(none)';
  if (subtype !== 'success' || result.is_error === true) {
    const detail = typeof result.result === 'string' && result.result ? `: ${result.result}` : '';
    throw new Error(`Claude Code ended the run with result "${subtype}"${detail}`);
  }

  const answer = typeof result.result === 'string' ? result.result : (lastText ?? '');
  const usage = isObject(result.usage) ? result.usage : undefined;
  return {
    answer,
    toolCalls,
    toolResults,
    ...(usage
      ? {
          tokensInput:
            numberOr0(usage.input_tokens) +
            numberOr0(usage.cache_creation_input_tokens) +
            numberOr0(usage.cache_read_input_tokens),
          tokensOutput: numberOr0(usage.output_tokens),
        }
      : {}),
  };
};
