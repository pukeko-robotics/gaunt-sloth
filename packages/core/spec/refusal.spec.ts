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
