import { describe, expect, it } from 'vitest';

import { resolveUseMouse } from '#src/config/mouse.js';

/**
 * TUI-C37 — the mouse ladder, rung by rung. Pure input in, boolean out, so every rung is provable
 * without a terminal or a config file.
 */
describe('resolveUseMouse', () => {
  const interactive = { term: 'xterm-256color', stdoutIsTTY: true, stdinIsTTY: true };

  describe('rung 1 — GTH_NO_MOUSE', () => {
    it('turns mouse off when set to any non-empty value', () => {
      expect(resolveUseMouse({ ...interactive, noMouse: '1' })).toBe(false);
      expect(resolveUseMouse({ ...interactive, noMouse: 'anything' })).toBe(false);
    });

    it('outranks an explicit config opt-in, so the no-config escape hatch always works', () => {
      expect(resolveUseMouse({ ...interactive, noMouse: '1', explicitUseMouse: true })).toBe(false);
    });

    it('does not count as set when empty, matching the NO_COLOR convention', () => {
      expect(resolveUseMouse({ ...interactive, noMouse: '' })).toBe(true);
    });

    it('does not count as set when the variable is absent', () => {
      expect(resolveUseMouse({ ...interactive, noMouse: undefined })).toBe(true);
    });
  });

  describe('rung 2 — explicit config', () => {
    it('is used verbatim when the user set it', () => {
      expect(resolveUseMouse({ ...interactive, explicitUseMouse: false })).toBe(false);
      expect(resolveUseMouse({ ...interactive, explicitUseMouse: true })).toBe(true);
    });

    it('lets an explicit opt-in override an unpromising TERM', () => {
      // Deliberate: someone on an unusual TERM that does support tracking can still ask for it.
      expect(
        resolveUseMouse({
          term: 'dumb',
          stdoutIsTTY: true,
          stdinIsTTY: true,
          explicitUseMouse: true,
        })
      ).toBe(true);
    });

    it('lets an explicit opt-in override the non-TTY default', () => {
      expect(
        resolveUseMouse({
          term: 'xterm',
          stdoutIsTTY: false,
          stdinIsTTY: false,
          explicitUseMouse: true,
        })
      ).toBe(true);
    });
  });

  describe('rung 3 — TERM', () => {
    it('is off on a dumb terminal', () => {
      expect(resolveUseMouse({ ...interactive, term: 'dumb' })).toBe(false);
    });

    it('is off when TERM is unset or empty', () => {
      expect(resolveUseMouse({ ...interactive, term: undefined })).toBe(false);
      expect(resolveUseMouse({ ...interactive, term: '' })).toBe(false);
    });
  });

  describe('rung 4 — the default', () => {
    it('is ON in an ordinary interactive terminal, with no configuration at all', () => {
      // Mari's decision: clicking has to work on first launch or the affordances are undiscoverable.
      expect(resolveUseMouse(interactive)).toBe(true);
    });

    it('is off when stdout is redirected', () => {
      expect(resolveUseMouse({ ...interactive, stdoutIsTTY: false })).toBe(false);
    });

    it('is off when stdin is piped — reports arrive on stdin, so both ends must be a terminal', () => {
      expect(resolveUseMouse({ ...interactive, stdinIsTTY: false })).toBe(false);
    });
  });
});
