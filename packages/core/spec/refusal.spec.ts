import { describe, expect, it } from 'vitest';
import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import { detectRefusal, buildRefusalMessage } from '#src/core/refusal.js';

// EXT-37 — the per-provider refusal-shape normalizer. Covers the three stop/finish-reason shapes
// gaunt-sloth's providers surface, plus the negatives that must NOT be mistaken for a refusal.
describe('detectRefusal', () => {
  it('detects OpenAI-family finish_reason=content_filter', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: { finish_reason: 'content_filter' },
    });
    expect(detectRefusal(msg)).toEqual({
      provider: 'openai',
      reason: 'content_filter',
      explanation: '',
    });
  });

  it('detects Anthropic stop_reason=refusal', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: { stop_reason: 'refusal' },
    });
    expect(detectRefusal(msg)).toEqual({
      provider: 'anthropic',
      reason: 'refusal',
      explanation: '',
    });
  });

  it('detects Bedrock Converse guardrail intervention (camelCase stopReason)', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: { stopReason: 'guardrail_intervened' },
    });
    expect(detectRefusal(msg)).toEqual({
      provider: 'bedrock',
      reason: 'guardrail_intervened',
      explanation: '',
    });
  });

  it('detects a Bedrock guardrail action flag in additional_kwargs', () => {
    const msg = new AIMessage({
      content: '',
      additional_kwargs: { 'amazon-bedrock-guardrailAction': 'INTERVENED' },
    });
    expect(detectRefusal(msg)?.provider).toBe('bedrock');
  });

  // EXT-41 (M-1) — content_filtered is a DISTINCT StopReason enum value from guardrail_intervened
  // in the AWS Bedrock Converse API; before this it mapped to null (a silent empty turn).
  it('detects Bedrock Converse content_filtered (camelCase stopReason)', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: { stopReason: 'content_filtered' },
    });
    expect(detectRefusal(msg)).toEqual({
      provider: 'bedrock',
      reason: 'content_filtered',
      explanation: '',
    });
  });

  it.each([
    { label: 'snake stop_reason', meta: { stop_reason: 'content_filtered' } },
    { label: 'finish_reason', meta: { finish_reason: 'content_filtered' } },
  ])('detects Bedrock content_filtered via $label', ({ meta }) => {
    const msg = new AIMessage({ content: '', response_metadata: meta });
    expect(detectRefusal(msg)).toEqual({
      provider: 'bedrock',
      reason: 'content_filtered',
      explanation: '',
    });
  });

  it('reads the finish/stop reason when it lands in additional_kwargs instead of response_metadata', () => {
    const msg = new AIMessage({
      content: '',
      additional_kwargs: { finish_reason: 'content_filter' },
    });
    expect(detectRefusal(msg)?.reason).toBe('content_filter');
  });

  it('works on an AIMessageChunk (streaming path)', () => {
    const chunk = new AIMessageChunk({
      content: '',
      response_metadata: { finish_reason: 'content_filter' },
    });
    expect(detectRefusal(chunk)?.provider).toBe('openai');
  });

  it('carries a string-content explanation', () => {
    const msg = new AIMessage({
      content: 'I cannot help with that request.',
      response_metadata: { stop_reason: 'refusal' },
    });
    expect(detectRefusal(msg)?.explanation).toBe('I cannot help with that request.');
  });

  it('extracts an explanation from content-block arrays', () => {
    const msg = new AIMessage({
      content: [
        { type: 'text', text: 'This violates ' },
        { type: 'text', text: 'the policy.' },
      ],
      response_metadata: { stop_reason: 'refusal' },
    });
    expect(detectRefusal(msg)?.explanation).toBe('This violates the policy.');
  });

  // CFG-33 — the refusal notice quotes the model's explanation verbatim to the user. Gemini marks a
  // thought summary `thought: true` and types it exactly like an answer part, so a naive fold over
  // the text parts would quote the model's private thinking back as its "explanation".
  it('does not quote a Gemini thought summary as the explanation', () => {
    const msg = new AIMessage({
      content: [
        { thought: true, type: 'text', text: 'The user seems to want something I should refuse. ' },
        { type: 'text', text: 'I cannot help with that.' },
      ],
      response_metadata: { stop_reason: 'refusal' },
    });
    expect(detectRefusal(msg)?.explanation).toBe('I cannot help with that.');
  });

  it('falls back to reasoning_content when content is empty', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: { finish_reason: 'content_filter' },
      additional_kwargs: { reasoning_content: 'declined on safety grounds' },
    });
    expect(detectRefusal(msg)?.explanation).toBe('declined on safety grounds');
  });

  it.each([
    'stop',
    'tool_calls',
    'length',
    'end_turn',
    'max_tokens',
    // EXT-41 — Bedrock Converse StopReason siblings that are NOT refusals must stay null, so the
    // new content_filtered branch never widens into a false positive on a normal Bedrock turn.
    'tool_use',
    'stop_sequence',
  ])('returns null for a normal finish/stop reason (%s)', (reason) => {
    const byFinish = new AIMessage({
      content: 'ok',
      response_metadata: { finish_reason: reason },
    });
    const byStop = new AIMessage({ content: 'ok', response_metadata: { stop_reason: reason } });
    expect(detectRefusal(byFinish)).toBeNull();
    expect(detectRefusal(byStop)).toBeNull();
  });

  it('returns null for a ToolMessage / non-model message', () => {
    expect(
      detectRefusal(new ToolMessage({ content: 'tool output', tool_call_id: 't1' }))
    ).toBeNull();
  });

  it('is defensive against non-message / malformed inputs', () => {
    expect(detectRefusal(null)).toBeNull();
    expect(detectRefusal(undefined)).toBeNull();
    expect(detectRefusal('content_filter')).toBeNull();
    expect(detectRefusal(42)).toBeNull();
    expect(detectRefusal({})).toBeNull();
    expect(detectRefusal({ response_metadata: null })).toBeNull();
    // A non-string finish_reason must not match.
    expect(detectRefusal({ response_metadata: { finish_reason: { nested: true } } })).toBeNull();
  });
});

describe('buildRefusalMessage', () => {
  it('includes the model explanation and frames the refusal as terminal, not a Gaunt Sloth error', () => {
    const msg = buildRefusalMessage({
      provider: 'anthropic',
      reason: 'refusal',
      explanation: 'I will not help with that.',
    });
    expect(msg).toContain('declined');
    expect(msg).toContain('not a Gaunt Sloth error');
    expect(msg).toContain('I will not help with that.');
    // Terminal framing: deterministic, do not retry as-is.
    expect(msg).toMatch(/deterministic/i);
  });

  it('states plainly when no explanation was provided', () => {
    const msg = buildRefusalMessage({
      provider: 'openai',
      reason: 'content_filter',
      explanation: '',
    });
    expect(msg).toContain('no explanation');
  });
});

// [[EXT-159]] — the same reader, widened. `refusal.ts` is now the metadata FEEDER of the
// termination taxonomy: one module reading a message's stop/finish reason, classifying it into the
// shared vocabulary. These cells cover the second member it reads — an answer cut off against the
// output cap — across the four spellings providers use for it, and pin the two negatives that keep
// an ordinary turn from being reported as a termination reason at all.
describe('detectStopMetadata — the metadata feeder', () => {
  // No `provider` on a truncation, deliberately: the token does not identify one. Anthropic and
  // Gemini both spell it `max_tokens` once case is normalised, and OpenAI and Ollama both spell it
  // `length` — so naming a family here would be a guess stated as a fact.
  it.each([
    ['OpenAI finish_reason=length', { finish_reason: 'length' }, 'length'],
    ['Anthropic stop_reason=max_tokens', { stop_reason: 'max_tokens' }, 'max_tokens'],
    ['Bedrock stopReason=max_tokens', { stopReason: 'max_tokens' }, 'max_tokens'],
    ['Gemini finishReason=MAX_TOKENS', { finishReason: 'MAX_TOKENS' }, 'max_tokens'],
    ['Ollama done_reason=length', { done_reason: 'length' }, 'length'],
  ])('classifies %s as output_truncated', async (_label, metadata, detail) => {
    const { detectStopMetadata } = await import('#src/core/refusal.js');
    const msg = new AIMessage({ content: 'half', response_metadata: metadata });
    expect(detectStopMetadata(msg)).toEqual({ category: 'output_truncated', detail });
  });

  it('reads the same spellings out of additional_kwargs', async () => {
    const { detectStopMetadata } = await import('#src/core/refusal.js');
    const msg = new AIMessageChunk({
      content: 'half',
      additional_kwargs: { finish_reason: 'length' },
    });
    expect(detectStopMetadata(msg)?.category).toBe('output_truncated');
  });

  it('classifies a refusal through the SAME call, so there is one reader of the metadata', async () => {
    const { detectStopMetadata } = await import('#src/core/refusal.js');
    const msg = new AIMessage({
      content: '',
      response_metadata: { finish_reason: 'content_filter' },
    });
    expect(detectStopMetadata(msg)).toEqual({
      category: 'content_refusal',
      provider: 'openai',
      detail: 'content_filter',
    });
  });

  // Only a TERMINAL and INTERESTING reason is reported. An ordinary stop is classified by the site
  // that ends the turn, and a reader that answered here would pin the wrong reason mid-round —
  // before the real one had happened.
  it('says nothing about an ordinary stop', async () => {
    const { detectStopMetadata } = await import('#src/core/refusal.js');
    const msg = new AIMessage({ content: 'done', response_metadata: { finish_reason: 'stop' } });
    expect(detectStopMetadata(msg)).toBeNull();
  });

  it('says nothing about a tool-call round or a non-message', async () => {
    const { detectStopMetadata } = await import('#src/core/refusal.js');
    const toolRound = new AIMessage({
      content: '',
      response_metadata: { finish_reason: 'tool_calls' },
    });
    expect(detectStopMetadata(toolRound)).toBeNull();
    expect(detectStopMetadata(new ToolMessage({ content: 'ok', tool_call_id: 'c1' }))).toBeNull();
    expect(detectStopMetadata(undefined)).toBeNull();
    expect(detectStopMetadata('a string')).toBeNull();
  });
});
