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

  /**
   * CFG-37 — the config key's rung in the chain. Each case here pairs the value under test with the
   * neighbour it must beat (or lose to), so a test can only pass while the rung sits where it does:
   * an inverted or relocated clause flips at least one expectation below.
   */
  describe('configuredTui (CFG-37)', () => {
    it('decides the surface when nothing louder has an opinion', async () => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      expect(shouldUseTui({ ...base, configuredTui: true })).toBe(true);
      expect(shouldUseTui({ ...base, configuredTui: false })).toBe(false);
    });

    it('leaves auto-detect in charge when unset', async () => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      // Both spellings of "nobody set it" behave as the pre-CFG-37 auto default.
      expect(shouldUseTui(base)).toBe(true);
      expect(shouldUseTui({ ...base, configuredTui: undefined })).toBe(true);
      expect(shouldUseTui({ ...base, ci: true, configuredTui: undefined })).toBe(false);
    });

    it('reads a configured FALSE as an answer, not as "unset"', async () => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      // The whole point of the `!== undefined` test: on an otherwise TUI-favourable terminal, the
      // auto default is `true`, so a `false` that leaks through as "unset" silently starts the TUI.
      expect(shouldUseTui({ ...base, configuredTui: false })).toBe(false);
    });

    it('loses to both flags', async () => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      expect(shouldUseTui({ ...base, configuredTui: true, noTuiFlag: true })).toBe(false);
      expect(shouldUseTui({ ...base, configuredTui: false, tuiFlag: true })).toBe(true);
    });

    it('loses to the GTH_NO_TUI escape hatch', async () => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      expect(shouldUseTui({ ...base, configuredTui: true, gthNoTui: true })).toBe(false);
    });

    it('beats the CI auto-off heuristic', async () => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      expect(shouldUseTui({ ...base, ci: true, configuredTui: true })).toBe(true);
      expect(shouldUseTui({ ...base, ci: true, configuredTui: false })).toBe(false);
    });

    it.each<[string, Partial<TuiDecisionInput>]>([
      ['ink not installed', { inkAvailable: false }],
      ['stdout not a TTY', { stdoutIsTTY: false }],
      ['stdin not a TTY', { stdinIsTTY: false }],
      ['TERM=dumb', { term: 'dumb' }],
    ])('cannot defeat a hard capability gate: %s', async (_label, gate) => {
      const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
      // A preference must never force a mount the terminal cannot support — it degrades to
      // readline. `--tui` is bundled in to prove the gates outrank the LOUDEST preference too.
      expect(shouldUseTui({ ...base, ...gate, configuredTui: true })).toBe(false);
      expect(shouldUseTui({ ...base, ...gate, configuredTui: true, tuiFlag: true })).toBe(false);
    });
  });

  it('--tui overrides GTH_NO_TUI (the flag is the loudest preference)', async () => {
    const { shouldUseTui } = await import('#src/tui/shouldUseTui.js');
    expect(shouldUseTui({ ...base, gthNoTui: true, tuiFlag: true })).toBe(true);
    // …and --no-tui still wins when both flags are somehow present.
    expect(shouldUseTui({ ...base, gthNoTui: true, tuiFlag: true, noTuiFlag: true })).toBe(false);
  });
});
