/**
 * @module agUiEvalRunner
 * BATCH-15 — the AG-UI target's production runner builders for `gth eval`. The eval runner
 * ({@link @gaunt-sloth/batch#runEvalSuite}) is target-agnostic: it consumes an injected
 * {@link RunCellFn} (single-shot) and {@link RunConversationFn} (multi-turn) and grades whatever
 * `answer` (and `tools`) they produce with the SAME assertion surface used for the `gth-agent`
 * target. This module builds those two functions for an EXTERNAL agent exposed over the AG-UI
 * protocol, driving its HTTP/SSE run endpoint — the analogue of `batchCommand.ts`'s
 * `buildProductionRunCell`/`buildProductionRunConversation` (in-process gth agent) and of
 * `adkEvalRunner.ts` (external ADK agent over A2A).
 *
 * The transport is INJECTABLE (like `RunCellFn`/`RunConversationFn` themselves) so unit tests drive
 * these builders against a FAKE client — or the real decoder against a FAKE `fetch` — with no
 * network and no live AG-UI server. The live end-to-end validation against a running `gth api ag-ui`
 * server is a separate node (BATCH-17).
 *
 * KEY DIFFERENCE from the ADK (A2A) runner: the AG-UI wire DOES stream the agent's tool calls
 * (`TOOL_CALL_START`). So this runner CAPTURES each `TOOL_CALL_START`'s `toolCallName` into the
 * outcome's `tools`, and `must_call`/`must_not_call` grade normally — unlike the adk-agent target,
 * where the tool trace is invisible and those assertions are rejected at parse time. AG-UI carries
 * no token accounting either, so `tokensInput`/`tokensOutput` are left unset (undefined).
 *
 * The wire contract (see the reference endpoint, `@gaunt-sloth/api`'s `apiAgUiModule.ts`):
 * - Request: `POST {url}/agents/{agentId}/run` with a `RunAgentInput` body
 *   `{ threadId, runId, messages, tools, forwardedProps }`.
 * - Response: an SSE stream of AG-UI events. We decode `TEXT_MESSAGE_CONTENT` deltas into the
 *   `answer`, `TOOL_CALL_START` names into `tools`, and treat `RUN_ERROR` (or a non-200, or a stream
 *   that ends without the terminal `RUN_FINISHED`) as a failed run — a gradeable `ok:false`, never
 *   an uncaught throw that aborts the whole suite.
 */
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import type {
  AgUiAgentTarget,
  RunCellFn,
  RunConversationFn,
  TurnRunOutcome,
} from '@gaunt-sloth/batch';

/** One AG-UI message as sent in the `RunAgentInput.messages` array. The eval only ever sends `user`
 * turns and, for conversation continuity, the `assistant` answers it assembled — the minimal shape
 * the reference server's `convertMessage` consumes (`{ id, role, content }`). */
export interface AgUiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** The `RunAgentInput` fields the runner drives per request. `threadId` provides conversation
 * continuity (stable across the turns of ONE conversation); `runId` is fresh per request. */
export interface AgUiRunInput {
  threadId: string;
  runId: string;
  messages: AgUiMessage[];
}

/** One AG-UI run's decoded result: the answer assembled from `TEXT_MESSAGE_CONTENT` deltas and the
 * tool names captured from `TOOL_CALL_START` events (empty array when the agent called no tools —
 * NOT undefined, so `must_not_call` grades against a real, present trace). */
export interface AgUiRunResult {
  answer: string;
  tools: string[];
}

/**
 * The minimal AG-UI client the runner depends on — a single `run(input)` that POSTs one
 * `RunAgentInput` and returns the decoded answer + tools. Production wraps {@link createAgUiClient};
 * tests inject a fake implementing exactly this. Kept deliberately narrow so a fake is trivial and
 * the runner never reaches into transport details.
 */
export interface AgUiClient {
  run(input: AgUiRunInput): Promise<AgUiRunResult>;
}

/** Builds an {@link AgUiClient} for a target — the injection seam for tests. */
export type AgUiClientFactory = (target: AgUiAgentTarget) => AgUiClient;

/** The `fetch` seam — global `fetch` in production, a fake in tests (so the real POST-body
 * construction + SSE decode are exercised with no network). */
export type FetchLike = typeof fetch;

/**
 * Decode an AG-UI SSE stream into an {@link AgUiRunResult}. The reference encoder frames each event
 * as `data: <json>\n\n` (`@ag-ui/encoder`), so we split on the blank-line delimiter, JSON-parse each
 * frame's `data:` payload, and fold the relevant event types:
 * - `TEXT_MESSAGE_CONTENT` → append `delta` to the answer.
 * - `TOOL_CALL_START` → capture `toolCallName` into `tools`.
 * - `RUN_ERROR` → remember the message; the run FAILED.
 * - `RUN_FINISHED` → the terminal success signal.
 *
 * Throws on `RUN_ERROR` OR on a stream that ends without a terminal `RUN_FINISHED` (a truncated /
 * malformed stream is a failed run, not an "empty answer" success). Non-JSON frames (SSE comments /
 * keep-alives) are ignored. The throw is contained by the runner builders below into `ok:false`.
 */
async function decodeAgUiStream(body: ReadableStream<Uint8Array>): Promise<AgUiRunResult> {
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const tools: string[] = [];
  let runError: string | undefined;
  let sawRunFinished = false;

  const handleFrame = (frame: string): void => {
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!payload) return;
    let event: { type?: string; delta?: unknown; toolCallName?: unknown; message?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      // Non-JSON frame (SSE comment / keep-alive) — ignore.
      return;
    }
    switch (event.type) {
      case EventType.TEXT_MESSAGE_CONTENT:
        if (typeof event.delta === 'string') answer += event.delta;
        break;
      case EventType.TOOL_CALL_START:
        if (typeof event.toolCallName === 'string') tools.push(event.toolCallName);
        break;
      case EventType.RUN_ERROR:
        runError = typeof event.message === 'string' ? event.message : 'unknown run error';
        break;
      case EventType.RUN_FINISHED:
        sawRunFinished = true;
        break;
    }
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      handleFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) handleFrame(buffer);

  if (runError !== undefined) {
    throw new Error(`AG-UI run error: ${runError}`);
  }
  if (!sawRunFinished) {
    throw new Error(
      'AG-UI stream ended without a terminal RUN_FINISHED event (truncated or malformed stream).'
    );
  }
  return { answer, tools };
}

/**
 * Create a real {@link AgUiClient} that drives the target's AG-UI run endpoint over HTTP/SSE. Each
 * `run` POSTs a `RunAgentInput` to `{url}/agents/{agentId}/run` and decodes the SSE response via
 * {@link decodeAgUiStream}. A non-2xx response, an absent body, a `RUN_ERROR` event, or a truncated
 * stream all throw — the runner builders contain that into a failed cell (`ok:false`).
 *
 * `fetchImpl` defaults to global `fetch`; tests pass a fake returning a synthetic SSE `Response` so
 * the body construction + decode are exercised without a network or a live server.
 */
export function createAgUiClient(
  target: AgUiAgentTarget,
  fetchImpl: FetchLike = fetch
): AgUiClient {
  const base = target.url.replace(/\/+$/, '');
  const endpoint = `${base}/agents/${encodeURIComponent(target.agentId)}/run`;
  return {
    async run(input) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          threadId: input.threadId,
          runId: input.runId,
          messages: input.messages,
          // The eval declares no client-fulfilled frontend tools; an empty array makes the server
          // serve the run from its own statically-configured agent.
          tools: [],
          forwardedProps: {},
        }),
      });
      if (!response.ok) {
        throw new Error(
          `AG-UI server responded ${response.status} ${response.statusText || ''}`.trim()
        );
      }
      if (!response.body) {
        throw new Error('AG-UI server returned no response body to stream.');
      }
      return decodeAgUiStream(response.body);
    },
  };
}

/** Production factory: a real HTTP/SSE {@link AgUiClient} over the target's AG-UI endpoint. */
export const defaultAgUiClientFactory: AgUiClientFactory = (target) => createAgUiClient(target);

/**
 * Build the injectable single-shot {@link RunCellFn} that drives ONE AG-UI run: send the cell's
 * prompt as the sole `user` message (fresh `threadId`/`runId`) and return the agent's assembled text
 * as the cell `answer` plus the tool names captured from the stream as `tools`. A transport/stream
 * error is contained as a failed cell (`ok:false`) so one bad case can never take the whole suite
 * down — matching `buildProductionRunCell`'s discipline for the gth-agent path.
 *
 * `tools` is ALWAYS populated (possibly `[]`) — the AG-UI wire exposes the trace — so
 * `must_call`/`must_not_call` grade normally, the key difference from the ADK target.
 */
export function buildAgUiRunCell(
  target: AgUiAgentTarget,
  createClient: AgUiClientFactory = defaultAgUiClientFactory
): RunCellFn {
  return async (cell) => {
    try {
      const client = createClient(target);
      const result = await client.run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', content: cell.content }],
      });
      return { ok: true, answer: result.answer, tools: result.tools };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * Build the injectable multi-turn {@link RunConversationFn} that drives a whole scripted conversation
 * against the AG-UI agent, threading continuity via the `messages` array + a STABLE `threadId` across
 * the turns of ONE conversation: each turn appends its `user` message, POSTs the accumulated history
 * under the same `threadId`, then appends the assistant's answer so the next turn's request carries
 * it. ONE `threadId` for the whole conversation; a fresh `runId` per turn.
 *
 * Returns one {@link TurnRunOutcome} per turn attempted (answer + per-turn tool trace). A turn that
 * throws is recorded as a failed turn and ABORTS the conversation (the returned array is short) — the
 * runner fails the un-run turns with a clear reason, exactly as it does for a gth-agent conversation
 * that ended early.
 */
export function buildAgUiRunConversation(
  target: AgUiAgentTarget,
  createClient: AgUiClientFactory = defaultAgUiClientFactory
): RunConversationFn {
  return async (userMessages) => {
    const client = createClient(target);
    const outcomes: TurnRunOutcome[] = [];
    // One stable thread for the whole conversation (continuity), plus the accumulated history the
    // server replays each turn (its `add_messages` reducer dedupes by id, so re-sending is safe).
    const threadId = randomUUID();
    const messages: AgUiMessage[] = [];

    for (const userMessage of userMessages) {
      messages.push({ id: randomUUID(), role: 'user', content: userMessage });
      try {
        const result = await client.run({
          threadId,
          runId: randomUUID(),
          // Snapshot the history so the caller/test sees exactly what THIS turn sent, unaffected by
          // later mutation.
          messages: [...messages],
        });
        // Thread the assistant's answer into the history so the next turn carries it (memory).
        messages.push({ id: randomUUID(), role: 'assistant', content: result.answer });
        outcomes.push({ ok: true, answer: result.answer, tools: result.tools });
      } catch (error) {
        outcomes.push({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        // A failed turn aborts the conversation — the runner marks the remaining turns FAILed.
        break;
      }
    }

    return outcomes;
  };
}
