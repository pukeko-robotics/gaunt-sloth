import { describe, expect, it } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Build a fake BaseChatModel whose `withStructuredOutput(schema).invoke()` returns (or throws)
 * what the test supplies. Deterministic — no live LLM. Mirrors
 * `packages/core/spec/shellJudge.spec.ts`'s `fakeModel` helper (EXT-10's judge tests), since
 * `judgeEvalCase` uses the exact same `withStructuredOutput` mechanism.
 */
function fakeModel(invokeImpl: (() => Promise<unknown>) | (() => unknown)): {
  model: BaseChatModel;
  structuredInvoke: ReturnType<typeof vi.fn>;
} {
  const structuredInvoke = vi.fn(async () => invokeImpl());
  const model = {
    withStructuredOutput: vi.fn(() => ({ invoke: structuredInvoke })),
  } as unknown as BaseChatModel;
  return { model, structuredInvoke };
}

describe('buildJudgeMessages', () => {
  it('embeds the rubric and the answer', async () => {
    const { buildJudgeMessages } = await import('#src/judge.js');
    const { system, user } = buildJudgeMessages('the answer text', 'the rubric text');
    expect(system).toMatch(/eval judge/i);
    expect(user).toContain('the rubric text');
    expect(user).toContain('<answer>');
    expect(user).toContain('the answer text');
    expect(user).toContain('</answer>');
  });

  it('renders a placeholder for an empty answer', async () => {
    const { buildJudgeMessages } = await import('#src/judge.js');
    const { user } = buildJudgeMessages('', 'rubric');
    expect(user).toContain('(empty answer)');
  });
});

describe('judgeEvalCase', () => {
  it('returns a passing verdict from the model', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');
    const { model, structuredInvoke } = fakeModel(() => ({ rate: 9, reason: 'Great answer.' }));

    const outcome = await judgeEvalCase('answer', 'rubric', model);

    expect(outcome).toEqual({
      attempted: true,
      ok: true,
      verdict: { rate: 9, reason: 'Great answer.' },
    });
    expect(structuredInvoke).toHaveBeenCalledOnce();
  });

  it('returns a low-rate verdict as-is (threshold comparison is the runner’s job, not the judge’s)', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');
    const { model } = fakeModel(() => ({ rate: 2, reason: 'Missed the point.' }));

    const outcome = await judgeEvalCase('answer', 'rubric', model);

    expect(outcome.ok).toBe(true);
    expect(outcome.verdict).toEqual({ rate: 2, reason: 'Missed the point.' });
  });

  it('FAILS the case (does not fail-closed-escalate) when the model throws', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');
    const { model } = fakeModel(() => {
      throw new Error('boom');
    });

    const outcome = await judgeEvalCase('answer', 'rubric', model);

    expect(outcome).toEqual({ attempted: true, ok: false, error: 'boom' });
  });

  it('FAILS the case when the model returns unparseable output', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');
    const { model } = fakeModel(() => ({ not: 'a verdict' }));

    const outcome = await judgeEvalCase('answer', 'rubric', model);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unparseable/);
  });

  it('FAILS the case when the model is unusable (no withStructuredOutput)', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');

    const outcome = await judgeEvalCase('answer', 'rubric', {} as unknown as BaseChatModel);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no usable judge model/i);
  });

  it('FAILS the case when no model is supplied at all', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');

    const outcome = await judgeEvalCase('answer', 'rubric', undefined);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no usable judge model/i);
  });

  it('FAILS the case on timeout', async () => {
    const { judgeEvalCase } = await import('#src/judge.js');
    const { model } = fakeModel(() => new Promise(() => {})); // never resolves

    const outcome = await judgeEvalCase('answer', 'rubric', model, { timeoutMs: 5 });

    expect(outcome).toEqual({ attempted: true, ok: false, error: 'Judge timed out after 5ms.' });
  });
});
