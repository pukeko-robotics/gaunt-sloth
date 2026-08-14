import { describe, expect, it } from 'vitest';
import {
  getEffectiveDevToolsConfig,
  getGhReadFileMaxBytes,
  getShellMaxOutputBytes,
  getShellTimeoutMs,
  isBuiltInToolEntryEnabled,
  isGhReadFileToolEnabled,
  isShellToolEnabled,
  normalizeBuiltInTools,
  GH_READ_FILE_DEFAULT_MAX_BYTES,
  SHELL_DEFAULT_MAX_OUTPUT_BYTES,
  SHELL_DEFAULT_TIMEOUT_MS,
  type GthConfig,
} from '#src/config.js';

/**
 * CFG-18 — the unified `builtInTools` registry is the single config surface for the dev/shell tools
 * (was per-command `devTools`). These tests exercise the NEW path end-to-end:
 * `builtInTools` (string[] | registry) → {@link getEffectiveDevToolsConfig} → the shell accessors.
 */
type Cfg = Pick<GthConfig, 'commands' | 'builtInTools' | 'askWriteMode'>;

describe('normalizeBuiltInTools', () => {
  it('maps the array form to an all-enabled lookup', () => {
    expect(normalizeBuiltInTools(['gth_checklist', 'gth_web_fetch'])).toEqual({
      gth_checklist: true,
      gth_web_fetch: true,
    });
  });

  it('passes the object (registry) form through unchanged', () => {
    const registry = { run_shell_command: { timeout: 5000 }, gth_checklist: false };
    expect(normalizeBuiltInTools(registry)).toBe(registry);
  });

  it('treats undefined as an empty registry', () => {
    expect(normalizeBuiltInTools(undefined)).toEqual({});
  });
});

describe('isBuiltInToolEntryEnabled', () => {
  it('enables bare true and any object not { enabled: false }', () => {
    expect(isBuiltInToolEntryEnabled(true)).toBe(true);
    expect(isBuiltInToolEntryEnabled({})).toBe(true);
    expect(isBuiltInToolEntryEnabled({ enabled: true })).toBe(true);
  });

  it('force-disables bare false and { enabled: false }; undefined is off', () => {
    expect(isBuiltInToolEntryEnabled(false)).toBe(false);
    expect(isBuiltInToolEntryEnabled({ enabled: false })).toBe(false);
    expect(isBuiltInToolEntryEnabled(undefined)).toBe(false);
  });
});

describe('getEffectiveDevToolsConfig (builtInTools → resolved GthDevToolsConfig)', () => {
  it('is inert (undefined) for commands that do not carry dev tools', () => {
    const config: Cfg = { builtInTools: { run_shell_command: true } };
    for (const command of ['chat', 'ask', 'pr', 'review', 'api'] as const) {
      expect(getEffectiveDevToolsConfig(config, command)).toBeUndefined();
    }
  });

  it('the object form ENABLES the shell for a do-the-job command', () => {
    const config: Cfg = { builtInTools: { run_shell_command: true } };
    const resolved = getEffectiveDevToolsConfig(config, 'exec');
    expect(isShellToolEnabled(resolved, 'exec')).toBe(true);
  });

  it('force-disables the (code-mode default-on) shell via { run_shell_command: false }', () => {
    const config: Cfg = { builtInTools: { run_shell_command: false } };
    const resolved = getEffectiveDevToolsConfig(config, 'code');
    // Really OFF even though code mode defaults the shell ON.
    expect(isShellToolEnabled(resolved, 'code')).toBe(false);
  });

  it('an object entry WITHOUT enabled still defaults ON in code (enabled ?? default)', () => {
    const config: Cfg = { builtInTools: { run_shell_command: { timeout: 5000 } } };
    const resolved = getEffectiveDevToolsConfig(config, 'code');
    expect(isShellToolEnabled(resolved, 'code')).toBe(true);
    expect(getShellTimeoutMs(resolved)).toBe(5000);
  });

  it('round-trips the full shell EXECUTION config (timeout/maxOutputBytes) through the accessors', () => {
    // CFG-26 — the approval knobs (allowlist/persistAllowlist/judge/yolo) no longer live on this
    // entry; they moved to the top-level `approvals` block (see approvalsConfig.spec.ts). What is
    // left here is execution-only, and that is the whole point of the split.
    const config: Cfg = {
      builtInTools: {
        run_shell_command: {
          enabled: true,
          timeout: 300000,
          maxOutputBytes: 200000,
        },
      },
    };
    const resolved = getEffectiveDevToolsConfig(config, 'code');
    expect(isShellToolEnabled(resolved, 'code')).toBe(true);
    expect(getShellTimeoutMs(resolved)).toBe(300000);
    expect(getShellMaxOutputBytes(resolved)).toBe(200000);
    expect(resolved?.shell).toEqual({
      enabled: true,
      timeout: 300000,
      maxOutputBytes: 200000,
    });
  });

  it('resolves the fixed run_* dev-command tools from their `command`', () => {
    const config: Cfg = {
      builtInTools: {
        run_tests: { command: 'npm test' },
        run_lint: { command: 'npm run lint' },
        run_single_test: { command: 'jest ${testPath}' },
      },
    };
    const resolved = getEffectiveDevToolsConfig(config, 'code');
    expect(resolved).toMatchObject({
      run_tests: 'npm test',
      run_lint: 'npm run lint',
      run_single_test: 'jest ${testPath}',
    });
  });

  it('a per-command builtInTools registry wins over the root one', () => {
    const config: Cfg = {
      builtInTools: { run_shell_command: false },
      commands: { code: { builtInTools: { run_shell_command: true } } },
    };
    const resolved = getEffectiveDevToolsConfig(config, 'code');
    expect(isShellToolEnabled(resolved, 'code')).toBe(true);
  });

  it('a bare string[] carries no dev entries → undefined (code shell default applies downstream)', () => {
    const config: Cfg = { builtInTools: ['gth_checklist'] };
    expect(getEffectiveDevToolsConfig(config, 'code')).toBeUndefined();
    // Downstream the absent-config default still turns the shell ON in code.
    expect(isShellToolEnabled(undefined, 'code')).toBe(true);
    // …with default timeout / output budget.
    expect(getShellTimeoutMs(undefined)).toBe(SHELL_DEFAULT_TIMEOUT_MS);
    expect(getShellMaxOutputBytes(undefined)).toBe(SHELL_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('ask --write reads commands.ask.builtInTools (only when askWriteMode is set)', () => {
    const config: Cfg = {
      askWriteMode: true,
      commands: { ask: { builtInTools: { run_shell_command: true } } },
    };
    expect(isShellToolEnabled(getEffectiveDevToolsConfig(config, 'ask'), 'ask')).toBe(true);

    // Without askWriteMode, plain `ask` carries no dev tools.
    const plain: Cfg = { commands: { ask: { builtInTools: { run_shell_command: true } } } };
    expect(getEffectiveDevToolsConfig(plain, 'ask')).toBeUndefined();
  });
});

/**
 * CFG-52 — `gth_gh_read_file` (the `gh api` file-read tool the review agent gets on a GitHub PR)
 * is configured through the SAME registry, but it is **opt-out**: absence means enabled. Each case
 * below is a PAIR, because either half alone also passes against an implementation that hardcoded
 * the answer.
 */
describe('isGhReadFileToolEnabled (CFG-52 — opt-out through the builtInTools registry)', () => {
  it('is ON when the registry does not name it, and OFF when it does with false', () => {
    // No config at all, and the shipped default registry (which never names this tool): ON.
    expect(isGhReadFileToolEnabled(undefined, 'pr')).toBe(true);
    expect(isGhReadFileToolEnabled({}, 'pr')).toBe(true);
    expect(isGhReadFileToolEnabled({ builtInTools: ['gth_checklist', 'gth_grep'] }, 'pr')).toBe(
      true
    );
    // Named false: OFF. This is the whole point of the ticket — a user CAN turn it off.
    expect(isGhReadFileToolEnabled({ builtInTools: { gth_gh_read_file: false } }, 'pr')).toBe(
      false
    );
    expect(
      isGhReadFileToolEnabled({ builtInTools: { gth_gh_read_file: { enabled: false } } }, 'pr')
    ).toBe(false);
  });

  it('an object entry that only configures the tool leaves it enabled', () => {
    expect(
      isGhReadFileToolEnabled({ builtInTools: { gth_gh_read_file: { maxBytes: 1000 } } }, 'pr')
    ).toBe(true);
    expect(isGhReadFileToolEnabled({ builtInTools: { gth_gh_read_file: true } }, 'pr')).toBe(true);
  });

  it('resolves per-command FIRST and root SECOND, for pr and review independently', () => {
    // Per-command wins over a root entry that says the opposite…
    const cmdWins: Cfg = {
      builtInTools: { gth_gh_read_file: true },
      commands: {
        pr: { builtInTools: { gth_gh_read_file: false } },
        review: { builtInTools: { gth_gh_read_file: false } },
      },
    };
    expect(isGhReadFileToolEnabled(cmdWins, 'pr')).toBe(false);
    expect(isGhReadFileToolEnabled(cmdWins, 'review')).toBe(false);

    // …and the root entry applies when the command sets no registry of its own. A resolver that
    // read ONLY config.builtInTools passes the first half and fails nothing here — but one that
    // read only the per-command key fails this half.
    const rootApplies: Cfg = { builtInTools: { gth_gh_read_file: false } };
    expect(isGhReadFileToolEnabled(rootApplies, 'pr')).toBe(false);
    expect(isGhReadFileToolEnabled(rootApplies, 'review')).toBe(false);

    // The two commands are resolved independently: disabling it for `pr` leaves `review` alone.
    const prOnly: Cfg = { commands: { pr: { builtInTools: { gth_gh_read_file: false } } } };
    expect(isGhReadFileToolEnabled(prOnly, 'pr')).toBe(false);
    expect(isGhReadFileToolEnabled(prOnly, 'review')).toBe(true);
  });

  it('picks the registry WHOLESALE — a per-command object replaces the root set, per key', () => {
    // The CFG-18 merge semantic: `commands.pr.builtInTools` REPLACES the root registry rather than
    // extending it, so a root entry the per-command registry does not name is NOT inherited. Under
    // a per-KEY fallback this would resolve to false, which is the bug this pins.
    const config: Cfg = {
      builtInTools: { gth_gh_read_file: false },
      commands: { pr: { builtInTools: { gth_checklist: true } } },
    };
    expect(isGhReadFileToolEnabled(config, 'pr')).toBe(true);
    // Root still governs `review`, which named no registry of its own.
    expect(isGhReadFileToolEnabled(config, 'review')).toBe(false);
  });
});

describe('getGhReadFileMaxBytes (CFG-52)', () => {
  // The LITERAL, deliberately not `GH_READ_FILE_DEFAULT_MAX_BYTES` — every other case here reads
  // the default back from the constant it is asserting, which is a value compared against itself
  // and stays green for any value at all. `docs/configuration/tools.md` promises this number to
  // users in words, so this is the only gate standing between a silent edit of the constant and a
  // shipped doc that lies about the shipped default.
  it('ships a default cap of 614400 bytes (600 KiB) — the number the docs promise', () => {
    expect(GH_READ_FILE_DEFAULT_MAX_BYTES).toBe(614400);
  });

  it('returns the configured cap, and the default when nothing configures one', () => {
    expect(
      getGhReadFileMaxBytes({ builtInTools: { gth_gh_read_file: { maxBytes: 200000 } } }, 'pr')
    ).toBe(200000);
    expect(getGhReadFileMaxBytes(undefined, 'pr')).toBe(GH_READ_FILE_DEFAULT_MAX_BYTES);
    expect(getGhReadFileMaxBytes({ builtInTools: { gth_gh_read_file: true } }, 'pr')).toBe(
      GH_READ_FILE_DEFAULT_MAX_BYTES
    );
    expect(getGhReadFileMaxBytes({ builtInTools: ['gth_gh_read_file'] }, 'pr')).toBe(
      GH_READ_FILE_DEFAULT_MAX_BYTES
    );
  });

  it('falls back to the default on an out-of-range or non-numeric value', () => {
    const cases = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '200000' as unknown as number];
    for (const maxBytes of cases) {
      expect(
        getGhReadFileMaxBytes({ builtInTools: { gth_gh_read_file: { maxBytes } } }, 'pr')
      ).toBe(GH_READ_FILE_DEFAULT_MAX_BYTES);
    }
  });

  it('reads the per-command cap first and the root cap second', () => {
    const config: Cfg = {
      builtInTools: { gth_gh_read_file: { maxBytes: 111 } },
      commands: { pr: { builtInTools: { gth_gh_read_file: { maxBytes: 222 } } } },
    };
    expect(getGhReadFileMaxBytes(config, 'pr')).toBe(222);
    // `review` names no registry, so the root cap applies there.
    expect(getGhReadFileMaxBytes(config, 'review')).toBe(111);
  });
});
