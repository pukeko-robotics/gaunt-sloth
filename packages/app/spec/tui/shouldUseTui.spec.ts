import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TuiDecisionInput } from '#src/tui/shouldUseTui.js';

/** A fully interactive, TUI-capable baseline; individual tests override one field. */
const base: TuiDecisionInput = {
  stdoutIsTTY: true,
  stdinIsTTY: true,
  noTuiFlag: false,
  tuiFlag: false,
  term: 'xterm-256color',
  ci: false,
  gthNoTui: false,
  inkAvailable: true,
};

describe('tui/shouldUseTui', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('opts in on an interactive terminal with ink available (auto default)', async () => {
    const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
    expect(shouldUseTui(base)).toBe(true);
  });

  it.each<[string, Partial<TuiDecisionInput>]>([
    ['ink not installed', { inkAvailable: false }],
    ['stdout not a TTY', { stdoutIsTTY: false }],
    ['stdin not a TTY', { stdinIsTTY: false }],
    ['TERM=dumb', { term: 'dumb' }],
    ['TERM=DUMB (case-insensitive)', { term: 'DUMB' }],
    ['--no-tui flag', { noTuiFlag: true }],
    ['GTH_NO_TUI env', { gthNoTui: true }],
    ['CI without --tui', { ci: true }],
  ])('falls back to readline: %s', async (_label, override) => {
    const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
    expect(shouldUseTui({ ...base, ...override })).toBe(false);
  });

  it('--tui overrides the CI gate (but still needs a TTY + ink)', async () => {
    const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
    expect(shouldUseTui({ ...base, ci: true, tuiFlag: true })).toBe(true);
    expect(shouldUseTui({ ...base, ci: true, tuiFlag: true, stdoutIsTTY: false })).toBe(false);
    expect(shouldUseTui({ ...base, ci: true, tuiFlag: true, inkAvailable: false })).toBe(false);
  });

  it('--no-tui beats --tui (explicit opt-out wins)', async () => {
    const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
    expect(shouldUseTui({ ...base, tuiFlag: true, noTuiFlag: true })).toBe(false);
  });

  it('treats a missing TERM as acceptable (not dumb)', async () => {
    const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
    expect(shouldUseTui({ ...base, term: undefined })).toBe(true);
  });
});
