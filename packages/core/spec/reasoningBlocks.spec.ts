import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';

/**
 * CFG-33 — the pure half of the reasoning bridge.
 *
 * The load-bearing claim is an EQUIVALENCE: for content that carries no reasoning block,
 * `answerTextOf` must return exactly what `BaseMessage.text` returns, or every provider's answer
 * rendering shifts. These assertions compare against a real message's `.text` rather than against a
 * hand-written expectation, so the two cannot drift apart on a shape nobody thought to list.
 */
describe('reasoningBlocks (CFG-33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const nonReasoningContents: Array<{ label: string; content: unknown }> = [
    { label: 'a plain string', content: 'hello world' },
    { label: 'an empty string', content: '' },
    { label: 'one text block', content: [{ type: 'text', text: 'hello' }] },
    {
      label: 'several text blocks',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    },
    {
      label: 'a text block beside a non-text block',
      content: [
        { type: 'text', text: 'caption' },
        { type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      ],
    },
    { label: 'a bare functionCall block', content: [{ type: 'functionCall', text: '' }] },
    { label: 'an empty array', content: [] },
  ];

  for (const { label, content } of nonReasoningContents) {
    it(`answerTextOf equals BaseMessage.text for ${label}`, async () => {
      const { answerTextOf } = await import('#src/core/reasoningBlocks.js');
      const message = new AIMessage({ content: content as never });
      expect(answerTextOf(content)).toBe(message.text);
    });

    it(`stripReasoningBlocks returns the same reference for ${label}`, async () => {
      const { stripReasoningBlocks } = await import('#src/core/reasoningBlocks.js');
      // Identity, not just equality: nothing matched, so no consumer sees a rebuilt object.
      expect(stripReasoningBlocks(content)).toBe(content);
    });
  }

  it('classifies a Gemini thought block as reasoning and keeps it out of the answer', async () => {
    const { answerTextOf, segmentAssistantContent } = await import('#src/core/reasoningBlocks.js');
    const content = [
      { thought: true, type: 'text', text: 'thinking' },
      { type: 'text', text: 'answering' },
    ];

    expect(segmentAssistantContent(content)).toEqual([
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'answer', text: 'answering' },
    ]);
    expect(answerTextOf(content)).toBe('answering');
    // This is the whole point: `.text` folds the thought into the answer, and we must not.
    expect(new AIMessageChunk({ content: content as never }).text).toBe('thinkinganswering');
  });

  it('strips only the thought block, preserving order and every other block', async () => {
    const { stripReasoningBlocks } = await import('#src/core/reasoningBlocks.js');
    const inlineData = { type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'AAAA' } };
    const content = [
      { thought: true, type: 'text', text: 'thinking' },
      { type: 'text', text: 'answering' },
      inlineData,
    ];

    expect(stripReasoningBlocks(content)).toEqual([
      { type: 'text', text: 'answering' },
      inlineData,
    ]);
  });

  it('does not claim a block that is merely typed `thinking` (Anthropic)', async () => {
    const { segmentAssistantContent } = await import('#src/core/reasoningBlocks.js');
    // Anthropic's thinking blocks are excluded from `.text` already and reach the reasoning channel
    // via additional_kwargs.reasoning_content. Matching them here would emit that thinking twice.
    expect(
      segmentAssistantContent([
        { type: 'thinking', thinking: 'anthropic thoughts' },
        { type: 'text', text: 'answer' },
      ])
    ).toEqual([{ kind: 'answer', text: 'answer' }]);
  });

  it('ignores a thought marker on a block that is not text', async () => {
    const { segmentAssistantContent, stripReasoningBlocks } =
      await import('#src/core/reasoningBlocks.js');
    const content = [{ thought: true, type: 'functionCall', functionCall: { name: 'x' } }];
    expect(segmentAssistantContent(content)).toEqual([]);
    // A tool-call part carries the thought signature Gemini needs replayed; never drop it.
    expect(stripReasoningBlocks(content)).toBe(content);
  });
});
