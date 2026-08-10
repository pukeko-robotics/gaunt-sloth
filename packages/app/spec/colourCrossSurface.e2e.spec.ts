import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk, { Chalk } from 'chalk';
import { resolveUseColour } from '@gaunt-sloth/core/config/colour.js';
import { applyTuiColour, clampedChalkLevel } from '#src/tui/colour.js';

/**
 * CFG-30 / TUI-C35 — do the two surfaces agree about colour?
 *
 * The plain readline surface decides via `resolveUseColour` (the CFG-30 ladder). The Ink TUI
 * renders through Ink and `packages/app/src/tui/markdown.ts`, and both call the same `chalk`
 * singleton — Ink's `chalk` resolves to the very same physical module as the app's. That is no
 * longer an accident of the dependency tree: `packages/app` is on `chalk@^6.0.0` while ink 7.1.1
 * still declares chalk 5, so the scoped `ink>chalk` override in `pnpm-workspace.yaml` is what
 * holds the module single. Lose it and Ink gets its own instance that the TUI's colour hook cannot
 * reach.
 *
 * **What changed in TUI-C35, and the trap in testing it.** Chalk does not implement `NO_COLOR` —
 * not in 5.6.2 and not in 6.0.0; its vendored `supports-color` handles `FORCE_COLOR` and the
 * `--no-color` flag only. So chalk's own detection can NOT be the thing this spec measures for
 * the TUI: under `NO_COLOR=1` on a terminal it returns truthy both before and after the fix, and
 * chasing that by adjusting what the helper measures ends in an assertion comparing the app's
 * helper against itself. The fix is not in chalk, it is `applyTuiColour` clamping chalk's level
 * from the resolved config at startup. So {@link tuiSaysColour} runs the REAL production hook
 * over a chalk instance seeded with chalk's own detection for the case, and then asks the only
 * question that matters: does styling this string actually emit an escape? Every case compares
 * that against a literal expectation in the table, never against `plainSaysColour`.
 *
 * Detection is `createSupportsColor` from chalk's vendored `supports-color`, which chalk calls
 * once at import as `createSupportsColor({isTTY: tty.isatty(1)})`. This spec calls the SAME
 * function with the TTY flag supplied explicitly, because `chalk.level` is fixed at import from
 * `tty.isatty(1)` and is 0 under vitest — seeding from it would pin 0-vs-0 forever and pass for
 * the wrong reason. `sniffFlags: false` keeps each call independent of the module-level
 * `flagForceColor` that `_supportsColor` mutates on the way through.
 */
const require_ = createRequire(import.meta.url);
const chalkVendoredSupportsColor = resolve(
  dirname(require_.resolve('chalk')),
  'vendor/supports-color/index.js'
);

type CreateSupportsColor = (
  _stream: { isTTY: boolean },
  _options: { sniffFlags: boolean }
) => false | { level: number };

let createSupportsColor: CreateSupportsColor;

/** Everything else chalk sniffs, cleared so only the case's variables can decide. */
const CONFOUNDERS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITEA_ACTIONS',
  'CIRCLECI',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TEAMCITY_VERSION',
  'TF_BUILD',
  'AGENT_NAME',
];

type ColourEnv = { NO_COLOR?: string; FORCE_COLOR?: string };

/** What chalk would decide unaided for this environment — the TUI's level BEFORE the hook runs. */
function chalkDetectedLevel(env: ColourEnv, stdoutIsTTY: boolean): 0 | 1 | 2 | 3 {
  vi.stubEnv('NO_COLOR', env.NO_COLOR);
  vi.stubEnv('FORCE_COLOR', env.FORCE_COLOR);
  const support = createSupportsColor({ isTTY: stdoutIsTTY }, { sniffFlags: false });
  return support ? (support.level as 0 | 1 | 2 | 3) : 0;
}

/** What the plain surface decides for the same inputs, with no explicit config value. */
function plainSaysColour(env: ColourEnv, stdoutIsTTY: boolean): boolean {
  return resolveUseColour({ forceColor: env.FORCE_COLOR, noColor: env.NO_COLOR, stdoutIsTTY });
}

/**
 * What the TUI ends up emitting: chalk seeded with its own detection, then handed to the real
 * `applyTuiColour` with the resolved config — exactly the production sequence — and finally asked
 * whether it still styles. Deliberately measures emitted escapes rather than the level, so a hook
 * that set a plausible-looking level but never reached the renderer would still be caught.
 */
function tuiSaysColour(env: ColourEnv, stdoutIsTTY: boolean): boolean {
  const instance = new Chalk({ level: chalkDetectedLevel(env, stdoutIsTTY) });
  applyTuiColour(plainSaysColour(env, stdoutIsTTY), instance);
  return instance.red('x') !== 'x';
}

describe('CFG-30 — the plain surface and the TUI reach the same colour decision', () => {
  beforeEach(async () => {
    ({ createSupportsColor } = (await import(pathToFileURL(chalkVendoredSupportsColor).href)) as {
      createSupportsColor: CreateSupportsColor;
    });
    for (const key of CONFOUNDERS) vi.stubEnv(key, undefined);
    vi.stubEnv('TERM', 'xterm-256color');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const agreeing: Array<[string, ColourEnv, boolean, boolean]> = [
    ['FORCE_COLOR=1 on a terminal', { FORCE_COLOR: '1' }, true, true],
    ['FORCE_COLOR=0 on a terminal', { FORCE_COLOR: '0' }, true, false],
    ['FORCE_COLOR=false on a terminal', { FORCE_COLOR: 'false' }, true, false],
    ['FORCE_COLOR= (empty but set) on a terminal', { FORCE_COLOR: '' }, true, true],
    ['FORCE_COLOR=1 forcing colour onto a pipe', { FORCE_COLOR: '1' }, false, true],
    ['FORCE_COLOR=0 on a pipe', { FORCE_COLOR: '0' }, false, false],
    ['nothing set, piped stdout', {}, false, false],
    ['nothing set, terminal stdout', {}, true, true],
  ];

  it.each(agreeing)('agree on %s', (_name, env, stdoutIsTTY, expected) => {
    expect(plainSaysColour(env, stdoutIsTTY)).toBe(expected);
    expect(tuiSaysColour(env, stdoutIsTTY)).toBe(expected);
  });

  it('agree under NO_COLOR once stdout is piped', () => {
    const env = { NO_COLOR: '1' };

    expect(plainSaysColour(env, false)).toBe(false);
    expect(tuiSaysColour(env, false)).toBe(false);
  });

  /**
   * THE CASE THIS NODE EXISTS FOR — and the one that fails if the clamp is removed.
   *
   * Until TUI-C35 this test asserted the opposite and was named "DIVERGE": the plain surface
   * obeyed `NO_COLOR` while the TUI kept colouring, because chalk ignores the variable entirely.
   * It is the only row in this file where chalk's unaided detection and the ladder disagree, so
   * it is the row that proves `applyTuiColour` is load-bearing rather than decorative — with the
   * clamp gone, the seeded instance keeps its detected level and still emits an escape here.
   */
  it('agree under NO_COLOR=1 in a terminal — the TUI clamps chalk, which ignores NO_COLOR', () => {
    const env = { NO_COLOR: '1' };

    // Chalk on its own still says colour: NO_COLOR appears nowhere in chalk 6.0.0's source.
    expect(chalkDetectedLevel(env, true)).toBeGreaterThan(0);
    // The startup hook is what closes the gap.
    expect(plainSaysColour(env, true)).toBe(false);
    expect(tuiSaysColour(env, true)).toBe(false);
  });
});

/**
 * The clamp's own contract. The cross-surface table above can only detect a missing clamp through
 * the one NO_COLOR-on-a-terminal row; "floor at 1 when detection found none" and "never promote a
 * terminal past what it reported" are otherwise unasserted, because every other row's detected
 * level already agrees with the ladder.
 */
describe('TUI-C35 — clampedChalkLevel clamps down only', () => {
  it('turns colour fully off regardless of what the terminal supports', () => {
    expect(clampedChalkLevel(3, false)).toBe(0);
    expect(clampedChalkLevel(2, false)).toBe(0);
    expect(clampedChalkLevel(1, false)).toBe(0);
    expect(clampedChalkLevel(0, false)).toBe(0);
  });

  it('floors at basic colour when colour is wanted but detection found none', () => {
    expect(clampedChalkLevel(0, true)).toBe(1);
  });

  it('never promotes a terminal past the level it reported', () => {
    expect(clampedChalkLevel(1, true)).toBe(1);
    expect(clampedChalkLevel(2, true)).toBe(2);
    expect(clampedChalkLevel(3, true)).toBe(3);
  });

  it('applies to a real chalk instance without tripping chalk 6 level validation', () => {
    const instance = new Chalk({ level: 3 });
    applyTuiColour(false, instance);
    expect(instance.level).toBe(0);
    expect(instance.red('x')).toBe('x');

    applyTuiColour(true, instance);
    expect(instance.level).toBe(1);
    expect(instance.red('x')).not.toBe('x');
  });

  /**
   * THE CLAIM THE WHOLE NODE RESTS ON, and the only case that exercises the production call
   * shape. Every other case here hands `applyTuiColour` an explicit instance, which proves the
   * arithmetic but NOT that the knob production turns is the shared `chalk` default export — the
   * very module Ink imports in `colorize.js` and `render-border.js`. Production calls
   * `applyTuiColour(useColour)` with no second argument, so that default parameter is what
   * reaches Ink, and without this case it would be asserted nowhere.
   *
   * The identity assertion is the load-bearing half: it fails if `tui/colour.ts` is ever changed
   * to construct its own `new Chalk()` (which would clamp nothing anybody renders through), and
   * it fails if the scoped `ink>chalk` overrides are dropped and the module splits.
   *
   * Restores the level in a `finally` — this mutates a module-global shared with every other
   * consumer in this worker.
   */
  it('clamps the SHARED default chalk export — the instance Ink renders through', async () => {
    const { default: chalkSeenByHook } = (await import(
      pathToFileURL(require_.resolve('chalk')).href
    )) as { default: typeof chalk };
    // Same physical module object the hook mutates, not merely an equal-looking one.
    expect(chalkSeenByHook).toBe(chalk);

    const before = chalk.level;
    try {
      chalk.level = 3;
      applyTuiColour(false);
      expect(chalk.level).toBe(0);
      expect(chalk.red('x')).toBe('x');

      applyTuiColour(true);
      expect(chalk.level).toBe(1);
      expect(chalk.red('x')).not.toBe('x');
    } finally {
      chalk.level = before;
    }
  });
});
