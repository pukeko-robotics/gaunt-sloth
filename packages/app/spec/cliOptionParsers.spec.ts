import { describe, expect, it } from 'vitest';

describe('parseIntOption', () => {
  it('parses a plain integer string', async () => {
    const { parseIntOption } = await import('#src/commands/cliOptionParsers.js');

    expect(parseIntOption('8')).toBe(8);
    expect(parseIntOption('0')).toBe(0);
  });

  // CI review finding (BATCH-2 PR #410): `parseInt(value, 10)` stops at the first non-digit and
  // returns the digits parsed so far (`parseInt('10abc', 10) === 10`), and `Number.isFinite` on
  // that result is still `true` — so trailing garbage after a valid-looking prefix silently
  // resolved to a number instead of being rejected. `-j/--concurrency 10abc` must throw, not
  // silently behave like `-j 10`.
  it('rejects a value with trailing garbage after a digit prefix, rather than truncating it', async () => {
    const { parseIntOption } = await import('#src/commands/cliOptionParsers.js');

    expect(() => parseIntOption('10abc')).toThrow('Expected an integer, got "10abc"');
  });

  it('rejects a non-numeric value', async () => {
    const { parseIntOption } = await import('#src/commands/cliOptionParsers.js');

    expect(() => parseIntOption('abc')).toThrow('Expected an integer, got "abc"');
  });

  it('rejects a non-integer numeric value', async () => {
    const { parseIntOption } = await import('#src/commands/cliOptionParsers.js');

    expect(() => parseIntOption('3.5')).toThrow('Expected an integer, got "3.5"');
  });

  it('rejects an empty string', async () => {
    const { parseIntOption } = await import('#src/commands/cliOptionParsers.js');

    expect(() => parseIntOption('')).toThrow('Expected an integer, got ""');
  });
});
