import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '#src/config/loader.js';

/**
 * Effective-merged acceptance gate (B2b). Runs consumer-shaped fixtures through the SAME merge
 * pipeline the loader uses (resolveConfig: deep-merge with DEFAULT_CONFIG + per-command merge +
 * array policy) and pins the effective output via a committed snapshot. If the array merge policy
 * (or any merge change) silently shifts how a real config resolves, the snapshot breaks. The
 * fixtures use only canonical names (2.0 rejects the deprecated shapes outright — see GS2-28), so
 * no pre-map step is involved.
 *
 * OPS-81 removed four cases that read the on-disk `examples/` configs, along with that directory —
 * its content now lives inline in the configuration docs. The fixtures below are declared in this
 * file, so the gate no longer depends on any path outside it.
 *
 * `resolveConfig` writes no globals (no LLM instantiation, no `set*` side effects), so `llm`
 * stays the raw spec object — fine for a deterministic snapshot.
 *
 * It does READ the environment, though: CFG-30 resolves `useColour` from `FORCE_COLOR` /
 * `NO_COLOR` / stdout's TTY status. The snapshot pins the merge policy, not the machine it ran on,
 * so the setup below DECLARES that environment — a terminal with neither colour variable set —
 * rather than inheriting the runner's piped stdout or a CI image that exports `FORCE_COLOR`.
 * Without this the committed `useColour` would flip with the ambient shell.
 */
function effective(raw: Record<string, unknown>): Record<string, unknown> {
  return resolveConfig(structuredClone(raw) as never, {}) as unknown as Record<string, unknown>;
}

describe('effective-merged acceptance (B2b)', () => {
  let realIsTTY: boolean | undefined;

  beforeEach(() => {
    realIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
  });

  afterEach(() => {
    process.stdout.isTTY = realIsTTY as boolean;
    vi.unstubAllEnvs();
  });

  it('resolves the consumer-shaped fixture to a stable effective config', () => {
    const fixture = {
      llm: { type: 'openai', model: 'gpt-5.4', configuration: { temperature: 0.7 } },
      builtInTools: ['show_a2ui_surface'],
      streamOutput: true,
      commands: {
        api: {
          port: 3000,
          cors: {
            allowOrigin: 'http://localhost:5555',
            allowMethods: 'POST, GET, OPTIONS',
            allowHeaders: 'Content-Type, Accept',
          },
        },
      },
    };
    expect(effective(fixture)).toMatchSnapshot();
  });

  /**
   * GS2-101 §2 — the run-header default lives at the READ SITE (`GthAbstractAgent#headerRung`),
   * never in `DEFAULT_CONFIG`, so `gth config` does not report a key the user never set. The
   * snapshots above would happily absorb a new `output.header` line on the next re-record, which is
   * exactly why this is asserted by name instead of left to them.
   */
  it('adds no output.header to the effective config of a config that never set it', () => {
    const resolved = effective({ llm: { type: 'openai', model: 'gpt-5.4' } });

    expect(resolved.output).toBeUndefined();
    expect(Object.keys(resolved)).not.toContain('output');
  });

  it('still carries an output.header the user DID set', () => {
    const resolved = effective({
      llm: { type: 'openai', model: 'gpt-5.4' },
      output: { header: 'debug' },
    });

    expect(resolved.output).toEqual({ header: 'debug' });
  });
});
