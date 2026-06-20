import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('tui/ruleWidth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses the full terminal width when known', async () => {
    const { ruleWidth } = await import('#src/tui/components/Rule.js');
    expect(ruleWidth(80)).toBe(80);
    expect(ruleWidth(160)).toBe(160);
    expect(ruleWidth(40)).toBe(40);
  });

  it('falls back to 80 columns when the width is undefined (non-TTY/tests)', async () => {
    const { ruleWidth } = await import('#src/tui/components/Rule.js');
    expect(ruleWidth(undefined)).toBe(80);
  });

  it('falls back to 80 columns for a non-finite width', async () => {
    const { ruleWidth } = await import('#src/tui/components/Rule.js');
    expect(ruleWidth(NaN)).toBe(80);
    expect(ruleWidth(Infinity)).toBe(80);
  });

  it('clamps to a minimum of 1 so it never collapses to 0/negative', async () => {
    const { ruleWidth } = await import('#src/tui/components/Rule.js');
    expect(ruleWidth(0)).toBe(1);
    expect(ruleWidth(1)).toBe(1);
    expect(ruleWidth(-10)).toBe(1);
  });

  it('floors fractional column counts', async () => {
    const { ruleWidth } = await import('#src/tui/components/Rule.js');
    expect(ruleWidth(99.9)).toBe(99);
  });
});
