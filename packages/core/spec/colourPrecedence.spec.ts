import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveUseColour } from '#src/config/colour.js';

/**
 * CFG-30 — the colour precedence ladder, rung by rung and at every conflict between rungs.
 *
 * Highest wins:
 *   1. FORCE_COLOR set  — "0"/"false" off, anything else (incl. "") on
 *   2. NO_COLOR set and non-empty — off
 *   3. useColour set explicitly in config — that value
 *   4. auto-detect — stdout is a TTY
 *
 * The first block drives the PURE helper, so each rung is one assertion with no process globals.
 * The second drives the REAL `resolveConfig` with the environment declared in setup, which is what
 * proves the rungs are actually wired into the merge (a green pure helper nobody calls is worth
 * nothing). The third proves the user-visible consequence: no escape bytes on the plain surface.
 */
describe('CFG-30 colour precedence — the pure ladder', () => {
  const base = { stdoutIsTTY: true };

  describe('rung 1: FORCE_COLOR outranks everything', () => {
    it.each([
      ['1', true],
      ['2', true],
      ['3', true],
      ['true', true],
      ['', true], // an empty-but-SET FORCE_COLOR means colour ON
      ['0', false],
      ['false', false],
    ])('FORCE_COLOR=%o resolves to %s', (forceColor, expected) => {
      expect(resolveUseColour({ ...base, forceColor })).toBe(expected);
    });

    it('beats NO_COLOR (the documented conflict: both set, FORCE_COLOR wins)', () => {
      expect(resolveUseColour({ ...base, forceColor: '1', noColor: '1' })).toBe(true);
    });

    it('turns colour OFF over NO_COLOR too when spelled 0 — it is an override, not a force-on', () => {
      expect(resolveUseColour({ ...base, forceColor: '0', noColor: '1' })).toBe(false);
    });

    it('beats an explicit config value in both directions', () => {
      expect(resolveUseColour({ ...base, forceColor: '0', explicitUseColour: true })).toBe(false);
      expect(resolveUseColour({ ...base, forceColor: '1', explicitUseColour: false })).toBe(true);
    });

    it('beats auto-detect: forces colour on a non-TTY (the pipe-to-a-file-with-colour case)', () => {
      expect(resolveUseColour({ stdoutIsTTY: false, forceColor: '1' })).toBe(true);
    });
  });

  describe('rung 2: NO_COLOR', () => {
    it('turns colour off when set and non-empty', () => {
      expect(resolveUseColour({ ...base, noColor: '1' })).toBe(false);
    });

    it('turns colour off for ANY non-empty value — presence is the signal, not the value', () => {
      expect(resolveUseColour({ ...base, noColor: 'anything at all' })).toBe(false);
      expect(resolveUseColour({ ...base, noColor: '0' })).toBe(false);
    });

    it('does NOT trigger on an empty value — an empty NO_COLOR falls through to the rungs below', () => {
      expect(resolveUseColour({ ...base, noColor: '' })).toBe(true); // falls to rung 4 (TTY)
      expect(resolveUseColour({ ...base, noColor: '', explicitUseColour: false })).toBe(false); // to rung 3
    });

    it('beats an explicit config value', () => {
      expect(resolveUseColour({ ...base, noColor: '1', explicitUseColour: true })).toBe(false);
    });
  });

  describe('rung 3: an explicit useColour', () => {
    it('is used verbatim when neither environment variable is set', () => {
      expect(resolveUseColour({ ...base, explicitUseColour: false })).toBe(false);
      expect(resolveUseColour({ stdoutIsTTY: false, explicitUseColour: true })).toBe(true);
    });

    it('beats auto-detect in BOTH directions (that is the whole point of the rung)', () => {
      // explicit ON survives a non-TTY...
      expect(resolveUseColour({ stdoutIsTTY: false, explicitUseColour: true })).toBe(true);
      // ...and explicit OFF survives a TTY.
      expect(resolveUseColour({ stdoutIsTTY: true, explicitUseColour: false })).toBe(false);
    });
  });

  describe('rung 4: auto-detect', () => {
    it('is ON for a terminal and OFF for a pipe when nothing else decides', () => {
      expect(resolveUseColour({ stdoutIsTTY: true })).toBe(true);
      expect(resolveUseColour({ stdoutIsTTY: false })).toBe(false);
    });

    it('treats an UNSET (undefined) variable as absent, not as an empty string', () => {
      expect(
        resolveUseColour({ stdoutIsTTY: false, forceColor: undefined, noColor: undefined })
      ).toBe(false);
    });
  });
});

/**
 * The same ladder as the real loader applies it. These use the REAL systemUtils, so the
 * environment is declared here rather than inherited.
 */
describe('CFG-30 colour precedence — wired into resolveConfig', () => {
  let realIsTTY: boolean | undefined;

  beforeEach(() => {
    realIsTTY = process.stdout.isTTY;
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
  });

  afterEach(() => {
    process.stdout.isTTY = realIsTTY as boolean;
    vi.unstubAllEnvs();
  });

  async function resolved(raw: Record<string, unknown>, isTTY: boolean): Promise<boolean> {
    process.stdout.isTTY = isTTY;
    const { resolveConfig } = await import('#src/config/loader.js');
    return resolveConfig(raw as never, {}).useColour;
  }

  it('NO_COLOR turns colour off even though the DEFAULT is on', async () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(await resolved({ llm: { type: 'x' } }, true)).toBe(false);
  });

  it('FORCE_COLOR=1 overrides NO_COLOR=1', async () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('FORCE_COLOR', '1');
    expect(await resolved({ llm: { type: 'x' } }, true)).toBe(true);
  });

  it('FORCE_COLOR=0 turns colour off on a terminal', async () => {
    vi.stubEnv('FORCE_COLOR', '0');
    expect(await resolved({ llm: { type: 'x' } }, true)).toBe(false);
  });

  it('an explicit useColour:false wins when no environment variable is set', async () => {
    expect(await resolved({ llm: { type: 'x' }, useColour: false }, true)).toBe(false);
  });

  it('NO_COLOR still beats an explicit useColour:true', async () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(await resolved({ llm: { type: 'x' }, useColour: true }, true)).toBe(false);
  });

  it('a non-TTY stdout with no env var and no explicit config resolves to NO colour', async () => {
    expect(await resolved({ llm: { type: 'x' } }, false)).toBe(false);
  });

  /**
   * The rung-3 keystone. `DEFAULT_CONFIG.useColour` is `true`, so after the default merge an
   * explicit `true` and an absent value are the same byte — explicitness has to be read from the
   * RAW config first. Both cases below are `true`-vs-absent on the SAME non-TTY stdout, so if the
   * loader ever reads `useColour` post-merge again, they collapse to one answer and this fails.
   */
  it('distinguishes an EXPLICIT useColour:true from the identical default on a non-TTY', async () => {
    expect(await resolved({ llm: { type: 'x' }, useColour: true }, false)).toBe(true);
    expect(await resolved({ llm: { type: 'x' } }, false)).toBe(false);
  });
});

/**
 * Acceptance: `NO_COLOR=1` means the plain surface emits ZERO escape sequences. Real consoleUtils
 * over real systemUtils — the actual bytes a user's pipe would receive.
 */
describe('CFG-30 — the plain surface under NO_COLOR', () => {
  let realIsTTY: boolean | undefined;
  let savedUseColour: boolean;

  beforeEach(async () => {
    realIsTTY = process.stdout.isTTY;
    const { getUseColour } = await import('#src/utils/systemUtils.js');
    savedUseColour = getUseColour();
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
  });

  afterEach(async () => {
    process.stdout.isTTY = realIsTTY as boolean;
    vi.unstubAllEnvs();
    const { setUseColour } = await import('#src/utils/systemUtils.js');
    setUseColour(savedUseColour);
    vi.restoreAllMocks();
  });

  /** Drive the real chain: resolve the config, apply it globally, print, capture the bytes. */
  async function printedBytes(): Promise<string> {
    const { resolveConfig } = await import('#src/config/loader.js');
    const { setUseColour } = await import('#src/utils/systemUtils.js');
    const { displayError, displayWarning, displaySuccess } =
      await import('#src/utils/consoleUtils.js');
    setUseColour(resolveConfig({ llm: { type: 'x' } } as never, {}).useColour);

    const captured: string[] = [];
    const record = (message?: unknown) => void captured.push(String(message));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
    vi.spyOn(console, 'info').mockImplementation(record);

    displayError('an error');
    displayWarning('a warning');
    displaySuccess('a success');
    return captured.join('');
  }

  it('emits no ANSI escape sequences at all on a terminal', async () => {
    process.stdout.isTTY = true;
    vi.stubEnv('NO_COLOR', '1');
    const output = await printedBytes();

    expect(output).not.toContain('\x1b');
    // The messages themselves still print — monochrome, not silenced.
    expect(output).toContain('an error');
    expect(output).toContain('a warning');
    expect(output).toContain('a success');
  });

  /**
   * The counter-case that stops the one above from passing for the wrong reason: on the SAME
   * terminal without NO_COLOR, these very calls DO emit escapes. Without this, an accidental
   * "colour is never on anywhere" regression would read as a pass.
   */
  it('DOES emit escape sequences on the same terminal without NO_COLOR', async () => {
    process.stdout.isTTY = true;
    const output = await printedBytes();

    expect(output).toContain('\x1b');
  });
});
