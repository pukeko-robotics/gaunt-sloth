import { describe, expect, it } from 'vitest';
import {
  getEffectiveDevToolsConfig,
  getShellJudgeSettings,
  getShellMaxOutputBytes,
  getShellTimeoutMs,
  isBuiltInToolEntryEnabled,
  isShellAllowlistEnabled,
  isShellAllowlistPersisted,
  isShellJudgeEnabled,
  isShellToolEnabled,
  normalizeBuiltInTools,
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

  it('round-trips the full shell config (timeout/allowlist/judge/yolo) through the accessors', () => {
    const config: Cfg = {
      builtInTools: {
        run_shell_command: {
          enabled: true,
          timeout: 300000,
          maxOutputBytes: 200000,
          allowlist: false,
          persistAllowlist: false,
          judge: { enabled: true, autoApproveLow: false, blockHigh: true },
          yolo: true,
        },
      },
    };
    const resolved = getEffectiveDevToolsConfig(config, 'code');
    expect(isShellToolEnabled(resolved, 'code')).toBe(true);
    expect(getShellTimeoutMs(resolved)).toBe(300000);
    expect(getShellMaxOutputBytes(resolved)).toBe(200000);
    expect(isShellAllowlistEnabled(resolved)).toBe(false);
    expect(isShellAllowlistPersisted(resolved)).toBe(false);
    expect(isShellJudgeEnabled(resolved)).toBe(true);
    expect(getShellJudgeSettings(resolved)).toMatchObject({
      enabled: true,
      autoApproveLow: false,
      blockHigh: true,
    });
    // shellYolo folded into the run_shell_command entry's `yolo` knob.
    expect(resolved?.shellYolo).toBe(true);
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
