import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { GthConfig } from '#src/config.js';
import { askStructured, ASK_STRUCTURED_DEFAULT_TIMEOUT_MS } from '#src/runtime/askStructured.js';

/**
 * Build a fake {@link GthConfig} whose `llm.withStructuredOutput(schema).invoke()` returns (or
 * throws) what the test supplies. Deterministic — no live LLM. Mirrors `shellJudge.spec.ts`'s
 * `fakeModel` helper, since `askStructured` uses the exact same `withStructuredOutput` mechanism;
 * wrapped in a config because `askStructured` reads the model from `config.llm`.
 */
function fakeConfig(invokeImpl: (() => Promise<unknown>) | (() => unknown)): {
  config: GthConfig;
  withStructuredOutput: ReturnType<typeof vi.fn>;
  structuredInvoke: ReturnType<typeof vi.fn>;
} {
  const structuredInvoke = vi.fn(async () => invokeImpl());
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  const config = { llm: { withStructuredOutput } } as unknown as GthConfig;
  return { config, withStructuredOutput, structuredInvoke };
}

const Schema = z.object({ name: z.string() });

describe('askStructured', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the parsed value on a schema-valid response', async () => {
    const { config, withStructuredOutput, structuredInvoke } = fakeConfig(() => ({ name: 'ok' }));

    const result = await askStructured(Schema, { config, system: 'sys', user: 'usr' });

    expect(result).toEqual({ ok: true, value: { name: 'ok' } });
    expect(withStructuredOutput).toHaveBeenCalledWith(Schema);
    expect(structuredInvoke).toHaveBeenCalledOnce();
  });

  it('fails (does not throw) when config.llm is missing', async () => {
    const config = {} as unknown as GthConfig;

    const result = await askStructured(Schema, { config, system: '', user: 'usr' });

    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, error: 'No usable model configured.' });
  });

  it('fails (does not throw) when the model has no withStructuredOutput', async () => {
    const config = { llm: {} } as unknown as GthConfig;

    const result = await askStructured(Schema, { config, system: 's', user: 'u' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no usable model/i);
  });

  it('fails with an unparseable error when the response does not match the schema', async () => {
    const { config } = fakeConfig(() => ({ wrong: 'shape' }));

    const result = await askStructured(Schema, { config, system: 's', user: 'u' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unparseable/);
  });

  it('fails with a timeout error when the model never resolves', async () => {
    const { config } = fakeConfig(() => new Promise(() => {})); // never resolves

    const result = await askStructured(Schema, {
      config,
      system: 's',
      user: 'u',
      timeoutMs: 5,
    });

    expect(result).toEqual({ ok: false, error: 'Structured call timed out after 5ms.' });
  });

  it('fails with the error message when invoke throws, without rethrowing', async () => {
    const { config } = fakeConfig(() => {
      throw new Error('boom');
    });

    const result = await askStructured(Schema, { config, system: 's', user: 'u' });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('defaults the timeout budget to 30_000ms', () => {
    expect(ASK_STRUCTURED_DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});
