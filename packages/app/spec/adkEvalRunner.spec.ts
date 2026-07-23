import { describe, expect, it, vi } from 'vitest';
import { parseEvalSuite } from '@gaunt-sloth/batch/evalSuite.js';
import { runEvalSuite } from '@gaunt-sloth/batch/evalRunner.js';
import type { AdkAgentTarget } from '@gaunt-sloth/batch';
import {
  buildAdkRunCell,
  buildAdkRunConversation,
  type AdkA2AClient,
  type AdkA2AResponse,
  type AdkClientFactory,
} from '#src/commands/adkEvalRunner.js';

// Fix #5 (BATCH-18): the production factory must build the A2A client through `A2AClientWrapper`,
// which itself now constructs via the non-deprecated `A2AClient.fromCardUrl(cardUrl)` — that
// migration (mock the SDK) is asserted in `packages/agent/spec/A2AClientWrapper.spec.ts`, where
// `@a2a-js/sdk` actually resolves (the app package has no such dependency, so a cross-package SDK
// mock cannot intercept the built wrapper's import). Here we mock the WRAPPER — which DOES resolve
// from the app package — to assert the factory wiring + preserved send behavior.
const mockSendMessageWithContext = vi.hoisted(() => vi.fn());
const A2AClientWrapperMock = vi.hoisted(() =>
  vi.fn(function A2AClientWrapperMock() {
    return { sendMessageWithContext: mockSendMessageWithContext };
  })
);
vi.mock('@gaunt-sloth/agent/modules/a2a/A2AClientWrapper.js', () => ({
  A2AClientWrapper: A2AClientWrapperMock,
}));

// BATCH-14 — the ADK (A2A) target's runner builders, driven end-to-end through the REAL
// `runEvalSuite` with a FAKE A2A client (no network, no live ADK agent — the live bed is BATCH-16).
// This proves both halves: the answer/contextId CAPTURE (the builders) and the GRADING (the shared
// assertion surface), for both the single-shot and multi-turn paths.

const TARGET: AdkAgentTarget = {
  type: 'adk-agent',
  url: 'http://localhost:8080',
  agentId: 'adk-agent',
};

/** A fake A2A client factory whose single `sendMessage` is the supplied spy. */
function fakeFactory(sendMessage: AdkA2AClient['sendMessage']): {
  createClient: AdkClientFactory;
  sendMessage: AdkA2AClient['sendMessage'];
} {
  const createClient: AdkClientFactory = () => ({ sendMessage });
  return { createClient, sendMessage };
}

const SINGLE_SHOT_SUITE = `
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
`;

const MULTI_TURN_SUITE = `
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: remembers
    turns:
      - user: "what contract types exist?"
        must_contain: ["contract"]
      - user: "how many did you just list?"
        must_match: ["\\\\b\\\\d+\\\\b"]
`;

describe('adkEvalRunner', () => {
  describe('single-shot (buildAdkRunCell)', () => {
    it('captures the ADK answer over A2A and grades it PASS through the real runEvalSuite', async () => {
      const suite = parseEvalSuite(SINGLE_SHOT_SUITE);
      const { createClient, sendMessage } = fakeFactory(
        vi.fn(async (text: string): Promise<AdkA2AResponse> => ({
          text: `hello there — re: ${text}`,
        }))
      );
      const runCell = buildAdkRunCell(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runCell });

      expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(summary.cases[0]).toMatchObject({
        id: 'greets',
        verdict: 'PASS',
        sutOk: true,
        answer: 'hello there — re: greet the user',
      });
      // The case's prompt was sent as the A2A message text.
      expect(sendMessage).toHaveBeenCalledWith('greet the user');
      // Honest boundary: A2A exposes no tool trace, so `tools` is never fabricated.
      expect(summary.cases[0].tools).toBeUndefined();
    });

    it('FAILs (sutOk:true) when the ADK answer misses a required substring', async () => {
      const suite = parseEvalSuite(SINGLE_SHOT_SUITE);
      const { createClient } = fakeFactory(vi.fn(async () => ({ text: 'goodbye' })));
      const runCell = buildAdkRunCell(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runCell });

      expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
      expect(summary.cases[0]).toMatchObject({ verdict: 'FAIL', sutOk: true });
    });

    it('records a transport error as a failed SUT run (sutOk:false) rather than crashing', async () => {
      const suite = parseEvalSuite(SINGLE_SHOT_SUITE);
      const { createClient } = fakeFactory(
        vi.fn(async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
        })
      );
      const runCell = buildAdkRunCell(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runCell });

      expect(summary.cases[0].sutOk).toBe(false);
      expect(summary.cases[0].verdict).toBe('FAIL');
      expect(summary.cases[0].reasons.join(' ')).toContain('ECONNREFUSED');
    });

    it('grades an adk answer with the judge — the judge is target-independent', async () => {
      const suite = parseEvalSuite(`
target: { type: adk-agent, url: "http://localhost:8080" }
cases:
  - id: judged
    prompt: "explain the thing"
    judge: "A clear explanation."
`);
      const { createClient } = fakeFactory(vi.fn(async () => ({ text: 'a clear explanation' })));
      const runCell = buildAdkRunCell(TARGET, createClient);
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

  describe('multi-turn contextId threading (buildAdkRunConversation)', () => {
    it('threads the A2A contextId across turns — turn 2 carries turn 1s returned context', async () => {
      const suite = parseEvalSuite(MULTI_TURN_SUITE);
      const calls: Array<{ text: string; context?: { contextId?: string; taskId?: string } }> = [];
      const sendMessage = vi.fn(
        async (
          text: string,
          context?: { contextId?: string; taskId?: string }
        ): Promise<AdkA2AResponse> => {
          calls.push({ text, context });
          if (calls.length === 1) {
            return {
              text: 'the contract types are A and B',
              contextId: 'ctx-123',
              taskId: 'task-1',
            };
          }
          return { text: 'there are 2 of them' };
        }
      );
      const createClient: AdkClientFactory = () => ({ sendMessage });
      const runConversation = buildAdkRunConversation(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runConversation });

      // Both turns graded PASS through the shared assertion surface.
      expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(summary.cases[0].turns).toHaveLength(2);
      expect(summary.cases[0].turns![0].verdict).toBe('PASS');
      expect(summary.cases[0].turns![1].verdict).toBe('PASS');

      // ONE client for the whole conversation, both messages in order.
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(calls[0].text).toBe('what contract types exist?');
      expect(calls[1].text).toBe('how many did you just list?');
      // Turn 1 sent NO context; turn 2 carried the contextId the first response returned.
      expect(calls[0].context).toBeUndefined();
      expect(calls[1].context).toEqual({ contextId: 'ctx-123' });
    });

    it('aborts the conversation on a mid-turn error and FAILs the un-run turn', async () => {
      const suite = parseEvalSuite(MULTI_TURN_SUITE);
      const sendMessage = vi
        .fn<AdkA2AClient['sendMessage']>()
        .mockResolvedValueOnce({ text: 'the contract types are A and B', contextId: 'ctx-1' })
        .mockRejectedValueOnce(new Error('stream reset by peer'));
      const createClient: AdkClientFactory = () => ({ sendMessage });
      const runConversation = buildAdkRunConversation(TARGET, createClient);

      const summary = await runEvalSuite(suite, { runConversation });

      expect(summary.cases[0].verdict).toBe('FAIL');
      // Turn 1 ran (PASS), turn 2 failed its SUT run — sutOk:true (a real product signal, not a
      // harness error), and the failing turn is named.
      expect(summary.cases[0].sutOk).toBe(true);
      expect(summary.cases[0].turns![0].verdict).toBe('PASS');
      expect(summary.cases[0].turns![1].ok).toBe(false);
      expect(summary.cases[0].reasons.some((r) => r.startsWith('turn 2:'))).toBe(true);
      expect(summary.cases[0].reasons.join(' ')).toContain('stream reset by peer');
    });
  });

  // Fix #5 (BATCH-18) — the production factory builds an A2AClientWrapper for the target and
  // delegates each send to its context-threading `sendMessageWithContext`. The wrapper's own
  // migration to `A2AClient.fromCardUrl` (mock the SDK) is proven in the agent-package spec; this
  // asserts the factory wiring and that the ADK runner's send behavior is unchanged.
  describe('defaultAdkClientFactory — A2AClientWrapper wiring (fix #5)', () => {
    it('constructs the wrapper for the target and delegates send to sendMessageWithContext', async () => {
      mockSendMessageWithContext.mockReset();
      A2AClientWrapperMock.mockClear();
      mockSendMessageWithContext.mockResolvedValue({
        text: 'pong',
        contextId: 'ctx-1',
        taskId: 'task-1',
      });

      const { defaultAdkClientFactory } = await import('#src/commands/adkEvalRunner.js');
      const client = defaultAdkClientFactory({
        type: 'adk-agent',
        url: 'http://localhost:8080',
        agentId: 'my-adk',
      });
      const res = await client.sendMessage('ping', { contextId: 'ctx-0' });

      // One wrapper built for the target's url + agentId.
      expect(A2AClientWrapperMock).toHaveBeenCalledWith({
        agentId: 'my-adk',
        agentUrl: 'http://localhost:8080',
      });
      // Behavior preserved: delegates to the context-threading send and returns its result verbatim.
      expect(mockSendMessageWithContext).toHaveBeenCalledWith('ping', { contextId: 'ctx-0' });
      expect(res).toEqual({ text: 'pong', contextId: 'ctx-1', taskId: 'task-1' });
    });

    it('defaults the wrapper agentId to "adk-agent" when the target omits it', async () => {
      mockSendMessageWithContext.mockReset();
      A2AClientWrapperMock.mockClear();
      mockSendMessageWithContext.mockResolvedValue({ text: 'ok' });

      const { defaultAdkClientFactory } = await import('#src/commands/adkEvalRunner.js');
      defaultAdkClientFactory({ type: 'adk-agent', url: 'http://localhost:8080' });

      expect(A2AClientWrapperMock).toHaveBeenCalledWith({
        agentId: 'adk-agent',
        agentUrl: 'http://localhost:8080',
      });
    });
  });
});
