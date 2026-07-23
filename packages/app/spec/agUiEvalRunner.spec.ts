import { describe, expect, it, vi } from 'vitest';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import { EventType } from '@ag-ui/core';
import type { AgUiAgentTarget } from '@gaunt-sloth/batch';
import {
  buildAgUiRunCell,
  buildAgUiRunConversation,
  createAgUiClient,
  type AgUiClient,
  type AgUiClientFactory,
  type AgUiRunInput,
  type AgUiRunResult,
  type FetchLike,
} from '#src/commands/agUiEvalRunner.js';

// BATCH-15 — the AG-UI target's runner builders, driven end-to-end through the REAL `runEvalSuite`.
// Two layers of test double, both without a network or a live AG-UI server (that live bed is
// BATCH-17):
//   1. A FAKE `fetch` returning synthetic SSE — exercises the REAL wire decode (createAgUiClient):
//      answer assembly, TOOL_CALL_START capture, RUN_ERROR/non-200/truncated-stream handling. The
//      tool-call capture claim (the whole point of ag-ui vs adk) rests on THIS layer, so it grades
//      `must_call`/`must_not_call` end-to-end through the decoder.
//   2. A FAKE `AgUiClient` (the injected factory seam) — exercises the runner/grading logic and the
//      multi-turn messages+threadId threading with a trivial double.

const TARGET: AgUiAgentTarget = { type: 'ag-ui', url: 'http://localhost:3000', agentId: 'gth' };

/** SSE-encode AG-UI events exactly as `@ag-ui/encoder` does: `data: <json>\n\n` per frame. */
function encodeSse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** A single-use async-iterable stream of the given string chunks (as `Uint8Array`), standing in for
 * `Response.body`. Splitting into multiple chunks proves frames are reassembled across boundaries. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  async function* gen(): AsyncGenerator<Uint8Array> {
    for (const c of chunks) yield enc.encode(c);
  }
  return gen() as unknown as ReadableStream<Uint8Array>;
}

/** A 200 SSE response carrying the given events as ONE chunk. */
function okStream(events: unknown[]): Partial<Response> {
  return { ok: true, status: 200, statusText: 'OK', body: streamOf([encodeSse(events)]) };
}

/** A fake `fetch` that records each call and returns a freshly-built response per call (so a stream
 * is never re-consumed across turns). */
function fakeFetch(makeResponse: () => Partial<Response>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return makeResponse() as Response;
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

/** Common event builders. */
const runStarted = { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' };
const runFinished = { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' };
const textStart = { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' };
const textEnd = { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' };
const textContent = (delta: string) => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: 'm1',
  delta,
});
const toolStart = (name: string) => ({
  type: EventType.TOOL_CALL_START,
  toolCallId: `tc-${name}`,
  toolCallName: name,
  parentMessageId: 'm1',
});

/** A fake `AgUiClient` factory whose single `run` is the supplied spy. */
function fakeClientFactory(run: AgUiClient['run']): {
  createClient: AgUiClientFactory;
  run: AgUiClient['run'];
} {
  return { createClient: () => ({ run }), run };
}

const SINGLE_SHOT_SUITE = `
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
`;

const MULTI_TURN_SUITE = `
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: remembers
    turns:
      - user: "what contract types exist?"
        must_contain: ["contract"]
      - user: "how many did you just list?"
        must_match: ["\\\\b\\\\d+\\\\b"]
`;

describe('agUiEvalRunner', () => {
  // Layer 1 — the REAL SSE decode (createAgUiClient) against a fake fetch.
  describe('createAgUiClient (real wire decode, fake fetch)', () => {
    it('assembles the answer from TEXT_MESSAGE_CONTENT deltas and captures TOOL_CALL_START into tools', async () => {
      const { fetchImpl, calls } = fakeFetch(() =>
        okStream([
          runStarted,
          textStart,
          textContent('The weather is '),
          textContent('sunny.'),
          toolStart('get_weather'),
          textEnd,
          runFinished,
        ])
      );
      const client = createAgUiClient(TARGET, fetchImpl);

      const result = await client.run({
        threadId: 'thread-1',
        runId: 'run-1',
        messages: [{ id: 'u1', role: 'user', content: 'weather?' }],
      });

      expect(result).toEqual({ answer: 'The weather is sunny.', tools: ['get_weather'] });
      // Drove the AG-UI protocol endpoint...
      expect(calls[0].url).toBe('http://localhost:3000/agents/gth/run');
      expect(calls[0].init.method).toBe('POST');
      // ...with a RunAgentInput body carrying threadId/runId/messages.
      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toMatchObject({
        threadId: 'thread-1',
        runId: 'run-1',
        messages: [{ id: 'u1', role: 'user', content: 'weather?' }],
      });
    });

    it('reassembles frames split across chunk boundaries', async () => {
      const full = encodeSse([
        runStarted,
        textStart,
        textContent('hel'),
        textContent('lo'),
        runFinished,
      ]);
      const mid = Math.floor(full.length / 2);
      const { fetchImpl } = fakeFetch(() => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: streamOf([full.slice(0, mid), full.slice(mid)]),
      }));
      const client = createAgUiClient(TARGET, fetchImpl);

      const result = await client.run({
        threadId: 't',
        runId: 'r',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      });
      expect(result.answer).toBe('hello');
    });

    it('ignores non-JSON keep-alive frames', async () => {
      const sse =
        ': keep-alive\n\n' + encodeSse([runStarted, textStart, textContent('ok'), runFinished]);
      const { fetchImpl } = fakeFetch(() => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: streamOf([sse]),
      }));
      const client = createAgUiClient(TARGET, fetchImpl);

      const result = await client.run({
        threadId: 't',
        runId: 'r',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      });
      expect(result.answer).toBe('ok');
    });

    it('throws on a RUN_ERROR event (gradeable failure, not a silent empty answer)', async () => {
      const { fetchImpl } = fakeFetch(() =>
        okStream([runStarted, { type: EventType.RUN_ERROR, message: 'model exploded' }])
      );
      const client = createAgUiClient(TARGET, fetchImpl);

      await expect(
        client.run({
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'u1', role: 'user', content: 'x' }],
        })
      ).rejects.toThrow(/model exploded/);
    });

    it('throws on a non-200 response', async () => {
      const { fetchImpl } = fakeFetch(() => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: streamOf(['']),
      }));
      const client = createAgUiClient(TARGET, fetchImpl);

      await expect(
        client.run({
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'u1', role: 'user', content: 'x' }],
        })
      ).rejects.toThrow(/503/);
    });

    it('throws when the stream ends without a terminal RUN_FINISHED (truncated/malformed)', async () => {
      // No RUN_FINISHED and no RUN_ERROR — a broken stream, NOT an "empty answer" success.
      const { fetchImpl } = fakeFetch(() =>
        okStream([runStarted, textStart, textContent('partial')])
      );
      const client = createAgUiClient(TARGET, fetchImpl);

      await expect(
        client.run({
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'u1', role: 'user', content: 'x' }],
        })
      ).rejects.toThrow(/RUN_FINISHED|truncated|malformed/i);
    });
  });

  // BATCH-18 — hardening against UNHEALTHY servers (the healthy path is BATCH-17's live bed). Each
  // test reproduces one failure mode a slow/broken server exhibits that a healthy one never does.
  describe('hardening against unhealthy servers (BATCH-18)', () => {
    // Fix #1 — a server that opens the SSE stream but never emits RUN_FINISHED must FAIL the case on
    // a deadline, not hang the process. A stream that yields a couple of frames then stalls forever.
    function stallingStream(prefixEvents: unknown[]): ReadableStream<Uint8Array> {
      const enc = new TextEncoder();
      async function* gen(): AsyncGenerator<Uint8Array> {
        yield enc.encode(encodeSse(prefixEvents));
        // Never resolves: the stream is open but no further frame (and no RUN_FINISHED) ever comes.
        await new Promise<void>(() => {});
      }
      return gen() as unknown as ReadableStream<Uint8Array>;
    }

    it('fix #1: a stalled stream (never RUN_FINISHED) fails on the deadline instead of hanging', async () => {
      const { fetchImpl } = fakeFetch(() => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: stallingStream([runStarted, textStart, textContent('thinking')]),
      }));
      // Tiny per-client deadline so the test is fast; production uses AG_UI_RUN_TIMEOUT_MS.
      const client = createAgUiClient(TARGET, fetchImpl, 50);

      const started = Date.now();
      await expect(
        client.run({
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'u1', role: 'user', content: 'x' }],
        })
      ).rejects.toThrow(/exceeded 50ms|stalled|RUN_FINISHED/i);
      // Resolved via the deadline, not a hang — well under any real run time.
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('fix #2: cancels/drains the response body on a non-200 so the socket is released', async () => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      // A body that records whether it was drained; the runner must cancel it on the non-200 path.
      const body = { cancel } as unknown as ReadableStream<Uint8Array>;
      const { fetchImpl } = fakeFetch(() => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body,
      }));
      const client = createAgUiClient(TARGET, fetchImpl);

      await expect(
        client.run({
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'u1', role: 'user', content: 'x' }],
        })
      ).rejects.toThrow(/503/);
      // The undrained stream was cancelled exactly once (no leaked socket).
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('fix #3: delimits multiple assistant messages instead of butt-joining them', async () => {
      const content = (messageId: string, delta: string) => ({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta,
      });
      const { fetchImpl } = fakeFetch(() =>
        okStream([
          runStarted,
          { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
          content('m1', 'first message'),
          { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
          { type: EventType.TEXT_MESSAGE_START, messageId: 'm2', role: 'assistant' },
          content('m2', 'second message'),
          { type: EventType.TEXT_MESSAGE_END, messageId: 'm2' },
          runFinished,
        ])
      );
      const client = createAgUiClient(TARGET, fetchImpl);

      const result = await client.run({
        threadId: 't',
        runId: 'r',
        messages: [{ id: 'u1', role: 'user', content: 'x' }],
      });
      // Two distinct assistant messages are newline-delimited, not run together.
      expect(result.answer).toBe('first message\nsecond message');
      expect(result.answer).not.toContain('messagesecond');
    });

    it('fix #4: parses an SSE payload delimited by lone "\\n" frame boundaries (not only "\\n\\n")', async () => {
      // Single-`\n` between frames, no blank-line separators — what a non-reference server may send.
      const lfFramed =
        [runStarted, textStart, textContent('lf ok'), toolStart('get_weather'), runFinished]
          .map((e) => `data: ${JSON.stringify(e)}`)
          .join('\n') + '\n';
      const { fetchImpl } = fakeFetch(() => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: streamOf([lfFramed]),
      }));
      const client = createAgUiClient(TARGET, fetchImpl);

      const result = await client.run({
        threadId: 't',
        runId: 'r',
        messages: [{ id: 'u1', role: 'user', content: 'x' }],
      });
      expect(result).toEqual({ answer: 'lf ok', tools: ['get_weather'] });
    });
  });

  // Layer 1 → grading: tool-call capture graded end-to-end through the REAL decoder (the whole point
  // of ag-ui vs adk). A fake STREAM emits a TOOL_CALL_START; must_call on that name PASSES, on
  // another name FAILS — proving the TOOL_CALL_START → tools seam, not just the grader.
  describe('tool-call capture graded through the real decoder', () => {
    // Every run streams a tool call for `get_weather` plus the text "sunny".
    const withToolCall = (): AgUiClientFactory => {
      const { fetchImpl } = fakeFetch(() =>
        okStream([
          runStarted,
          textStart,
          textContent('sunny'),
          toolStart('get_weather'),
          textEnd,
          runFinished,
        ])
      );
      return () => createAgUiClient(TARGET, fetchImpl);
    };

    it('must_call PASSES when the streamed tool name matches', async () => {
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: uses-weather
    prompt: "what is the weather?"
    must_call: ["get_weather"]
    must_contain: ["sunny"]
`);
      const runCell = buildAgUiRunCell(TARGET, withToolCall());
      const summary = await runEvalSuite(suite, { runCell });

      expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(summary.cases[0]).toMatchObject({ verdict: 'PASS', sutOk: true });
      expect(summary.cases[0].tools).toEqual(['get_weather']);
    });

    it('must_call FAILS when the streamed tool name does not match (no silent pass)', async () => {
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: wrong-tool
    prompt: "what is the weather?"
    must_call: ["book_flight"]
`);
      const runCell = buildAgUiRunCell(TARGET, withToolCall());
      const summary = await runEvalSuite(suite, { runCell });

      expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
      expect(summary.cases[0].verdict).toBe('FAIL');
      expect(summary.cases[0].reasons.join(' ')).toContain('did not call "book_flight"');
    });

    it('must_not_call FAILS when a forbidden tool was actually streamed', async () => {
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: forbidden
    prompt: "what is the weather?"
    must_not_call: ["get_weather"]
`);
      const runCell = buildAgUiRunCell(TARGET, withToolCall());
      const summary = await runEvalSuite(suite, { runCell });

      expect(summary.cases[0].verdict).toBe('FAIL');
      expect(summary.cases[0].reasons.join(' ')).toContain('called forbidden tool "get_weather"');
    });
  });

  // Layer 2 — the runner/grading logic with a FAKE AgUiClient at the injection seam.
  describe('single-shot (buildAgUiRunCell, fake client)', () => {
    it('captures the AG-UI answer + tools and grades PASS through the real runEvalSuite', async () => {
      const suite = parseEvalSuite(SINGLE_SHOT_SUITE);
      const { createClient, run } = fakeClientFactory(
        vi.fn(async (input: AgUiRunInput): Promise<AgUiRunResult> => ({
          answer: `hello there — re: ${input.messages[0].content}`,
          tools: [],
        }))
      );
      const runCell = buildAgUiRunCell(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runCell });

      expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(summary.cases[0]).toMatchObject({
        id: 'greets',
        verdict: 'PASS',
        sutOk: true,
        answer: 'hello there — re: greet the user',
      });
      // The prompt was sent as the sole `user` message; tools present (empty), not undefined.
      const input = (run as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgUiRunInput;
      expect(input.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'greet the user' }),
      ]);
      expect(summary.cases[0].tools).toEqual([]);
    });

    it('FAILs (sutOk:true) when the answer misses a required substring', async () => {
      const suite = parseEvalSuite(SINGLE_SHOT_SUITE);
      const { createClient } = fakeClientFactory(
        vi.fn(async () => ({ answer: 'goodbye', tools: [] }))
      );
      const runCell = buildAgUiRunCell(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runCell });

      expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
      expect(summary.cases[0]).toMatchObject({ verdict: 'FAIL', sutOk: true });
    });

    it('records a transport error as a failed SUT run (sutOk:false) rather than crashing', async () => {
      const suite = parseEvalSuite(SINGLE_SHOT_SUITE);
      const { createClient } = fakeClientFactory(
        vi.fn(async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
        })
      );
      const runCell = buildAgUiRunCell(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runCell });

      expect(summary.cases[0].sutOk).toBe(false);
      expect(summary.cases[0].verdict).toBe('FAIL');
      expect(summary.cases[0].reasons.join(' ')).toContain('ECONNREFUSED');
    });

    it('grades an ag-ui answer with the judge — the judge is target-independent', async () => {
      const suite = parseEvalSuite(`
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: judged
    prompt: "explain the thing"
    judge: "A clear explanation."
`);
      const { createClient } = fakeClientFactory(
        vi.fn(async () => ({ answer: 'a clear explanation', tools: [] }))
      );
      const runCell = buildAgUiRunCell(TARGET, createClient);
      const judge = vi.fn(async () => ({
        attempted: true,
        ok: true,
        verdict: { rate: 9, reason: 'clear' },
      }));

      const summary = await runEvalSuite(suite, { runCell, judge });

      expect(judge).toHaveBeenCalledWith('a clear explanation', 'A clear explanation.');
      expect(summary.cases[0].verdict).toBe('PASS');
    });
  });

  describe('multi-turn messages + threadId threading (buildAgUiRunConversation, fake client)', () => {
    it('threads the same threadId and carries turn 1s answer into turn 2s messages', async () => {
      const suite = parseEvalSuite(MULTI_TURN_SUITE);
      const inputs: AgUiRunInput[] = [];
      const run = vi.fn(async (input: AgUiRunInput): Promise<AgUiRunResult> => {
        // Snapshot: the runner passes a fresh array copy each turn, so recording the ref is safe.
        inputs.push(input);
        if (inputs.length === 1) return { answer: 'the contract types are A and B', tools: [] };
        return { answer: 'there are 2 of them', tools: [] };
      });
      const createClient: AgUiClientFactory = () => ({ run });
      const runConversation = buildAgUiRunConversation(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runConversation });

      // Both turns graded PASS through the shared assertion surface.
      expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(summary.cases[0].turns).toHaveLength(2);
      expect(summary.cases[0].turns![0].verdict).toBe('PASS');
      expect(summary.cases[0].turns![1].verdict).toBe('PASS');

      expect(run).toHaveBeenCalledTimes(2);
      // Turn 1: just the first user message.
      expect(inputs[0].messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'what contract types exist?'],
      ]);
      // Turn 2: turn 1's user + turn 1's ASSISTANT ANSWER + turn 2's user (memory), same threadId.
      expect(inputs[1].messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'what contract types exist?'],
        ['assistant', 'the contract types are A and B'],
        ['user', 'how many did you just list?'],
      ]);
      expect(inputs[1].threadId).toBe(inputs[0].threadId);
      // Fresh runId per turn.
      expect(inputs[1].runId).not.toBe(inputs[0].runId);
    });

    it('aborts the conversation on a mid-turn error and FAILs the un-run turn', async () => {
      const suite = parseEvalSuite(MULTI_TURN_SUITE);
      const run = vi
        .fn<AgUiClient['run']>()
        .mockResolvedValueOnce({ answer: 'the contract types are A and B', tools: [] })
        .mockRejectedValueOnce(new Error('stream reset by peer'));
      const createClient: AgUiClientFactory = () => ({ run });
      const runConversation = buildAgUiRunConversation(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runConversation });

      expect(summary.cases[0].verdict).toBe('FAIL');
      // Turn 1 ran (PASS); turn 2 failed its SUT run — sutOk:true (a real product signal).
      expect(summary.cases[0].sutOk).toBe(true);
      expect(summary.cases[0].turns![0].verdict).toBe('PASS');
      expect(summary.cases[0].turns![1].ok).toBe(false);
      expect(summary.cases[0].reasons.some((r) => r.startsWith('turn 2:'))).toBe(true);
      expect(summary.cases[0].reasons.join(' ')).toContain('stream reset by peer');
    });
  });
});
