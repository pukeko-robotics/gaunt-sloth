import { describe, expect, it } from 'vitest';
import { isShellToolEnabled, type GthDevToolsConfig } from '#src/config.js';

const dt = (shell: GthDevToolsConfig['shell']): GthDevToolsConfig => ({ shell });

/**
 * EXT-12 Part 1 — the shell tool is ON by default in `code` mode (still gated), OFF elsewhere,
 * while an EXPLICIT value (boolean or `{ enabled }`) always wins as a hard escape hatch.
 */
describe('isShellToolEnabled (EXT-12 default resolution)', () => {
  describe('absent / undefined devTools.shell', () => {
    it('resolves ENABLED for the code command', () => {
      expect(isShellToolEnabled(undefined, 'code')).toBe(true);
      expect(isShellToolEnabled({}, 'code')).toBe(true);
      expect(isShellToolEnabled({ run_tests: 'npm test' }, 'code')).toBe(true);
    });

    it('resolves DISABLED for non-code commands (exec, ask, chat) and when no command given', () => {
      expect(isShellToolEnabled(undefined, 'exec')).toBe(false);
      expect(isShellToolEnabled({}, 'exec')).toBe(false);
      expect(isShellToolEnabled(undefined, 'ask')).toBe(false);
      expect(isShellToolEnabled(undefined, 'chat')).toBe(false);
      // No command at all (historical OFF-by-default behaviour preserved).
      expect(isShellToolEnabled(undefined)).toBe(false);
      expect(isShellToolEnabled({})).toBe(false);
    });
  });

  describe('explicit value always wins (escape hatch)', () => {
    it('shell:false fully disables it even in code mode', () => {
      expect(isShellToolEnabled(dt(false), 'code')).toBe(false);
      expect(isShellToolEnabled(dt({ enabled: false }), 'code')).toBe(false);
    });

    it('shell:true / { enabled: true } enables it for any command', () => {
      expect(isShellToolEnabled(dt(true), 'code')).toBe(true);
      expect(isShellToolEnabled(dt(true), 'exec')).toBe(true);
      expect(isShellToolEnabled(dt({ enabled: true }), 'exec')).toBe(true);
      expect(isShellToolEnabled(dt(true))).toBe(true);
    });
  });

  // CFG-18: `enabled ?? default` — an object entry WITHOUT `enabled` (e.g. only configuring the
  // timeout/allowlist) no longer silently disables the shell; it falls back to the per-mode default
  // (ON in `code`, OFF elsewhere). This is the behavioural change from the old `enabled === true`.
  describe('object form WITHOUT `enabled` falls back to the per-mode default', () => {
    it('resolves ENABLED in code mode when only knobs are set', () => {
      expect(isShellToolEnabled(dt({ timeout: 5000 }), 'code')).toBe(true);
      expect(isShellToolEnabled(dt({ allowlist: false, judge: true }), 'code')).toBe(true);
    });

    it('resolves DISABLED for non-code commands (and no command) when only knobs are set', () => {
      expect(isShellToolEnabled(dt({ timeout: 5000 }), 'exec')).toBe(false);
      expect(isShellToolEnabled(dt({ timeout: 5000 }))).toBe(false);
    });
  });
});
