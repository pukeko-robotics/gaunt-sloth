/**
 * @module adkEvalRunner
 * BATCH-14 — the ADK (A2A) target's production runner builders for `gth eval`. The eval runner
 * ({@link @gaunt-sloth/batch#runEvalSuite}) is target-agnostic: it consumes an injected
 * {@link RunCellFn} (single-shot) and {@link RunConversationFn} (multi-turn) and grades whatever
 * `answer` they produce with the SAME assertion surface used for the `gth-agent` target. This module
 * builds those two functions for an EXTERNAL Google ADK agent, driving it over the A2A protocol via
 * {@link A2AClientWrapper} (the existing `@a2a-js/sdk` wrapper) — the analogue of `batchCommand.ts`'s
 * `buildProductionRunCell`/`buildProductionRunConversation` for the in-process gth agent.
 *
 * The A2A client is INJECTABLE (like `RunCellFn`/`RunConversationFn` themselves) so unit tests drive
 * these builders against a FAKE client with no network and no live ADK agent — the live end-to-end
 * validation is a separate node (BATCH-16).
 *
 * Honest boundaries (BATCH-14 design point 4): A2A exposes text (and file/data) parts plus task
 * status/artifact events, but NOT the agent's intermediate tool/function calls — so the ADK outcomes
 * never populate `tools`, and `must_call`/`must_not_call` are rejected at suite-parse time rather
 * than silently passed. A2A likewise carries no token accounting, so `tokensInput`/`tokensOutput`
 * are left unset (undefined), unlike the gth-agent path.
 */
import type {
  AdkAgentTarget,
  RunCellFn,
  RunConversationFn,
  TurnRunOutcome,
} from '@gaunt-sloth/batch';
import { A2AClientWrapper } from '@gaunt-sloth/agent/modules/a2a/A2AClientWrapper.js';

/** One A2A turn's result as the ADK runner needs it: the answer text plus the continuity handles to
 * thread into follow-up turns. */
export interface AdkA2AResponse {
  text: string;
  contextId?: string;
  taskId?: string;
}

/**
 * The minimal A2A client the ADK runner depends on — a single `sendMessage(text, context?)` that
 * returns text + continuity handles. Production wraps {@link A2AClientWrapper.sendMessageWithContext};
 * tests inject a fake implementing exactly this. Kept deliberately narrow so a fake is trivial and
 * the runner never reaches into the full SDK surface.
 */
export interface AdkA2AClient {
  sendMessage(
    text: string,
    context?: { contextId?: string; taskId?: string }
  ): Promise<AdkA2AResponse>;
}

/** Builds an {@link AdkA2AClient} for a target — the injection seam for tests. */
export type AdkClientFactory = (target: AdkAgentTarget) => AdkA2AClient;

/** Production factory: a real {@link A2AClientWrapper} over the target's A2A endpoint, adapted to the
 * narrow {@link AdkA2AClient} shape via its context-threading {@link A2AClientWrapper.sendMessageWithContext}. */
export const defaultAdkClientFactory: AdkClientFactory = (target) => {
  const wrapper = new A2AClientWrapper({
    agentId: target.agentId ?? 'adk-agent',
    agentUrl: target.url,
  });
  return {
    sendMessage: (text, context) => wrapper.sendMessageWithContext(text, context),
  };
};

/**
 * Build the injectable single-shot {@link RunCellFn} that drives ONE ADK agent turn over A2A: send
 * the cell's prompt as the A2A message text and return the agent's text as the cell `answer`. A
 * transport/agent error is contained as a failed cell (`ok:false`) so one bad case can never take the
 * whole suite down — matching `buildProductionRunCell`'s discipline for the gth-agent path.
 *
 * `tools`/tokens are intentionally unset (A2A exposes neither); content assertions grade the answer.
 */
export function buildAdkRunCell(
  target: AdkAgentTarget,
  createClient: AdkClientFactory = defaultAdkClientFactory
): RunCellFn {
  return async (cell) => {
    try {
      const client = createClient(target);
      const { text } = await client.sendMessage(cell.content);
      return { ok: true, answer: text };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * Build the injectable multi-turn {@link RunConversationFn} that drives a whole scripted conversation
 * against the ADK agent over A2A, threading the A2A `contextId` across turns so turn N sees turn
 * N-1's context (an ADK agent keeps conversational memory by `contextId`). ONE client is built for
 * the conversation; the first turn sends no context, and each subsequent turn carries the `contextId`
 * the previous response returned.
 *
 * Returns one {@link TurnRunOutcome} per turn attempted. A turn that throws is recorded as a failed
 * turn and ABORTS the conversation (the returned array is short) — the runner fails the un-run turns
 * with a clear reason, exactly as it does for a gth-agent conversation that ended early.
 */
export function buildAdkRunConversation(
  target: AdkAgentTarget,
  createClient: AdkClientFactory = defaultAdkClientFactory
): RunConversationFn {
  return async (userMessages) => {
    const client = createClient(target);
    const outcomes: TurnRunOutcome[] = [];
    let contextId: string | undefined;

    for (const message of userMessages) {
      try {
        const response = await client.sendMessage(message, contextId ? { contextId } : undefined);
        // Carry the server's contextId forward so the next turn continues the same conversation.
        if (response.contextId) contextId = response.contextId;
        outcomes.push({ ok: true, answer: response.text });
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
