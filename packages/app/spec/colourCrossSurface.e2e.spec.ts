import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveUseColour } from '@gaunt-sloth/core/config/colour.js';

/**
 * CFG-30 — do the two surfaces agree about colour?
 *
 * The plain readline surface decides via `resolveUseColour` (the CFG-30 ladder). The Ink TUI never
 * asks: it renders through Ink and `packages/app/src/tui/markdown.ts`, and both call the same
 * `chalk` singleton — Ink's `chalk` dependency resolves to the very same physical module as the
 * app's — so chalk's own colour-support detection IS the TUI's colour decision.
 *
 * That detection is `createSupportsColor` from chalk's vendored `supports-color`, which chalk calls
 * once at import as `createSupportsColor({isTTY: tty.isatty(1)})`. This test calls the SAME
 * function with the TTY flag supplied explicitly. Feeding it matters: `chalk.level` is fixed at
 * import from `tty.isatty(1)` and is 0 under vitest, so comparing against it would pin 0-vs-0
 * forever and pass for the wrong reason. `sniffFlags: false` keeps each call independent of the
 * module-level `flagForceColor` that `_supportsColor` mutates on the way through.
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

/** What chalk — and therefore the TUI — decides for this environment and stdout. */
function tuiSaysColour(env: ColourEnv, stdoutIsTTY: boolean): boolean {
  vi.stubEnv('NO_COLOR', env.NO_COLOR);
  vi.stubEnv('FORCE_COLOR', env.FORCE_COLOR);
  return Boolean(createSupportsColor({ isTTY: stdoutIsTTY }, { sniffFlags: false }));
}

/** What the plain surface decides for the same inputs, with no explicit config value. */
function plainSaysColour(env: ColourEnv, stdoutIsTTY: boolean): boolean {
  return resolveUseColour({ forceColor: env.FORCE_COLOR, noColor: env.NO_COLOR, stdoutIsTTY });
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

  it('agree under NO_COLOR once stdout is piped — the divergence below is terminal-only', () => {
    const env = { NO_COLOR: '1' };

    expect(plainSaysColour(env, false)).toBe(false);
    expect(tuiSaysColour(env, false)).toBe(false);
  });

  /**
   * KNOWN DIVERGENCE, pinned deliberately rather than asserted away.
   *
   * The CFG-30 brief assumed chalk honours NO_COLOR, so the TUI would need no change. It does not:
   * chalk 5.6.2's vendored supports-color never reads NO_COLOR at all (only the `--no-color` CLI
   * flag and FORCE_COLOR) — confirmed in its source and by running chalk on a real TTY, where
   * `NO_COLOR=1` still yielded `chalk.level = 3`. So in a terminal the plain surface now goes
   * monochrome while the TUI keeps colouring.
   *
   * Closing that gap means neutralising the shared chalk singleton from the TUI entry point, which
   * lands in `packages/app/src/tui/**` and so arms the `it-tui` PTY gate and its Windows CI cell —
   * outside this node's scope, and a coordinator call. This case records the gap as MEASURED fact
   * and is the tripwire: it goes red the day chalk starts honouring NO_COLOR, or the day someone
   * fixes the TUI — which is exactly when the follow-up should be closed.
   */
  it('DIVERGE on NO_COLOR=1 in a terminal — chalk ignores NO_COLOR, so the TUI still colours', () => {
    const env = { NO_COLOR: '1' };

    expect(plainSaysColour(env, true)).toBe(false); // the plain surface obeys NO_COLOR
    expect(tuiSaysColour(env, true)).toBe(true); // …and chalk, hence the TUI, does not
  });
});
