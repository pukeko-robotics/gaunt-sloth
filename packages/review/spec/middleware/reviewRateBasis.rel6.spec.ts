import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REL-6 — the rating request is bounded by the run's guard threshold, and a small review's rating
 * request is exactly what it always was. The estimator and the compaction summary helpers are
 * core's real ones; only the console, the artifact store and the model are stand-ins.
 */
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
  debugLogError: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/state/artifactStore.js', () => ({
  setArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  getArtifact: vi.fn(() => ({ rate: 8 })),
}));
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  getNewRunnableConfig: () => ({}),
}));

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  createCompactionSummaryMessage,
  isCompactionSummary,
} from '@gaunt-sloth/core/core/compaction.js';
import { estimatePromptTokens } from '@gaunt-sloth/core/core/GthLangChainAgent.js';

const invokeMock = vi.fn();
const config = {
  llm: { bindTools: vi.fn(() => ({ invoke: invokeMock })) },
} as unknown as GthConfig;

const READ_CHARACTERS = 7000;

function read(i: number): BaseMessage[] {
  return [
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'gth_gh_read_file_diff', args: { path: `f${i}.ts` }, id: `r${i}` }],
    }),
    new ToolMessage({ content: `READ ${i} ` + 'x'.repeat(READ_CHARACTERS), tool_call_id: `r${i}` }),
  ];
}

const FINAL_REVIEW = 'FINAL REVIEW ' + 'finding. '.repeat(500);

/** A folded review run: a summary, five reads, then the verdict. */
function foldedRun(): BaseMessage[] {
  return [
    createCompactionSummaryMessage('SUMMARY OF THE REVIEW SO FAR'),
    ...[0, 1, 2, 3, 4].flatMap(read),
    new AIMessage(FINAL_REVIEW),
  ];
}

async function rate(
  messages: BaseMessage[],
  thresholdSource?: () => Promise<number | null>
): Promise<BaseMessage[]> {
  const { createReviewRateMiddleware } = await import('#src/middleware/reviewRateMiddleware.js');
  const middleware = await createReviewRateMiddleware(
    {},
    config,
    thresholdSource ? { thresholdSource } : {}
  );
  await (middleware as unknown as { afterAgent: (s: unknown) => Promise<unknown> }).afterAgent({
    messages,
  });
  expect(invokeMock).toHaveBeenCalledTimes(1);
  return invokeMock.mock.calls[0][0] as BaseMessage[];
}

const text = (m: BaseMessage): string => (typeof m.content === 'string' ? m.content : '');

describe('REL-6 — the rating request fits the run’s guard threshold', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      tool_calls: [{ name: 'gth_review_rate', args: { rate: 8, comment: 'ok' }, id: 'x' }],
    });
  });

  it('a small review sends exactly the messages it always did', async () => {
    const messages = [new HumanMessage('a diff'), new AIMessage('a short review')];
    const sent = await rate(messages, async () => 100_000);

    expect(sent).toHaveLength(messages.length + 1);
    messages.forEach((message, i) => expect(sent[i]).toBe(message));
    expect(HumanMessage.isInstance(sent[2])).toBe(true);
    expect(text(sent[2])).toContain('gth_review_rate');
    // And it is the same request the middleware sends with no threshold at all.
    invokeMock.mockClear();
    const untouched = await rate(messages);
    expect(untouched).toEqual(sent);
  });

  it('sends the whole run unchanged when no threshold resolves', async () => {
    const messages = foldedRun();
    const sent = await rate(messages, async () => null);
    expect(sent.slice(0, -1)).toEqual(messages);
  });

  it('keeps the review whole, then the summary, then the newest reads, and fits the threshold', async () => {
    const messages = foldedRun();
    const threshold = 6000;
    expect(estimatePromptTokens(messages)).toBeGreaterThan(threshold);

    const sent = await rate(messages, async () => threshold);

    expect(estimatePromptTokens(sent)).toBeLessThanOrEqual(threshold);
    expect(isCompactionSummary(sent[0])).toBe(true);
    // The verdict is the last model turn, byte for byte.
    expect(text(sent[sent.length - 2])).toBe(FINAL_REVIEW);
    const kept = sent.filter((m) => ToolMessage.isInstance(m)).map((m) => text(m).split(' ')[1]);
    // Newest first until the budget ran out, sent in their original order.
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(5);
    expect(kept).toEqual(['0', '1', '2', '3', '4'].slice(5 - kept.length));
    // Every tool result still follows the call that asked for it.
    sent.forEach((m, i) => {
      if (ToolMessage.isInstance(m)) {
        const call = sent[i - 1] as AIMessage;
        expect(call.tool_calls?.[0]?.id).toBe(m.tool_call_id);
      }
    });
  });

  it('opens with a note when there is no summary to open with', async () => {
    const { RATING_BASIS_OMISSION_NOTE } = await import('#src/middleware/reviewRateMiddleware.js');
    const messages = [
      new HumanMessage('THE DIFF ' + 'd'.repeat(20_000)),
      ...[0, 1].flatMap(read),
      new AIMessage(FINAL_REVIEW),
    ];
    const sent = await rate(messages, async () => 6000);
    expect(text(sent[0])).toBe(RATING_BASIS_OMISSION_NOTE);
    expect(sent.some((m) => text(m).startsWith('THE DIFF'))).toBe(false);
    expect(text(sent[sent.length - 2])).toBe(FINAL_REVIEW);
    expect(estimatePromptTokens(sent)).toBeLessThanOrEqual(6000);
  });

  it('never cuts the review, even when the review alone is past the threshold', async () => {
    const huge = 'HUGE REVIEW ' + 'finding. '.repeat(5000);
    const messages = [createCompactionSummaryMessage('S'), ...read(0), new AIMessage(huge)];
    const sent = await rate(messages, async () => 2000);
    expect(text(sent[sent.length - 2])).toBe(huge);
    expect(sent.some((m) => ToolMessage.isInstance(m))).toBe(false);
  });

  it('a threshold that cannot be read leaves the request as it was', async () => {
    const messages = foldedRun();
    const sent = await rate(messages, async () => {
      throw new Error('no status');
    });
    expect(sent.slice(0, -1)).toEqual(messages);
  });
});
