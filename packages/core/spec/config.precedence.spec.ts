import { describe, expect, it } from 'vitest';
import { resolveConfig } from '#src/config/loader.js';
import type { RawGthConfig } from '#src/config.js';

/**
 * GS2-60 — config precedence for the precedence-picked command fields
 * (`filesystem`/`builtInTools`/`allowedTools`/`binaryFormats`). Calls `resolveConfig` directly (the
 * pure merge — no LLM instantiation, no process-global side effects), which is the exact site the
 * fix lives, and asserts the 4-layer precedence baked into every command:
 *
 *   per-command explicit > top-level explicit > per-command default > top-level default
 *
 * selected with `!== undefined` at each layer, so falsy-but-EXPLICIT values (`'none'`, `[]`) are
 * honoured rather than skipped as "missing".
 */
const ALL_COMMANDS = ['pr', 'review', 'code', 'exec', 'ask', 'chat', 'api'] as const;
const LLM = { llm: { type: 'anthropic' } };

function resolveCommands(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return resolveConfig(raw as unknown as RawGthConfig, {}).commands as unknown as Record<
    string,
    Record<string, unknown>
  >;
}

describe('GS2-60 config precedence (precedence-picked command fields)', () => {
  describe('filesystem', () => {
    it('TRAP: an UNSET top-level must NOT override a per-command default', () => {
      const c = resolveCommands({ ...LLM });
      // do-the-job commands keep their write/read defaults
      expect(c.code.filesystem).toBe('all');
      expect(c.exec.filesystem).toBe('all');
      // q&a / interactive commands keep their read defaults
      expect(c.ask.filesystem).toBe('read');
      expect(c.chat.filesystem).toBe('read');
      expect(c.api.filesystem).toBe('read');
      // pr/review carry NO per-command default → fall through to the top-level default 'none'
      expect(c.pr.filesystem).toBe('none');
      expect(c.review.filesystem).toBe('none');
    });

    it("reporter's case (#405): an explicit top-level 'none' applies to EVERY command incl. code/exec", () => {
      const c = resolveCommands({ ...LLM, filesystem: 'none' });
      for (const cmd of ALL_COMMANDS) {
        expect(c[cmd].filesystem).toBe('none');
      }
    });

    it("behavior delta: an explicit top-level 'read' narrows code/exec from 'all' to 'read'; ask stays 'read'", () => {
      const c = resolveCommands({ ...LLM, filesystem: 'read' });
      expect(c.code.filesystem).toBe('read'); // previously ignored → stayed 'all'
      expect(c.exec.filesystem).toBe('read'); // previously ignored → stayed 'all'
      expect(c.api.filesystem).toBe('read');
      expect(c.ask.filesystem).toBe('read');
      expect(c.pr.filesystem).toBe('read');
    });

    it('per-command explicit beats an explicit top-level (both directions)', () => {
      const c = resolveCommands({
        ...LLM,
        filesystem: 'none',
        commands: { code: { filesystem: 'all' } },
      });
      expect(c.code.filesystem).toBe('all'); // per-command explicit wins
      expect(c.exec.filesystem).toBe('none'); // top-level explicit beats exec's 'all' default
      expect(c.ask.filesystem).toBe('none'); // top-level explicit beats ask's 'read' default
    });

    it("eval acceptance: top-level 'none' resolves `ask` filesystem to 'none' (zero fs read tools)", () => {
      expect(resolveCommands({ ...LLM, filesystem: 'none' }).ask.filesystem).toBe('none');
    });
  });

  describe('builtInTools (regression guard — this already worked; must still work)', () => {
    it('an explicit top-level [] applies to every command', () => {
      const c = resolveCommands({ ...LLM, builtInTools: [] });
      for (const cmd of ALL_COMMANDS) {
        expect(c[cmd].builtInTools).toEqual([]);
      }
    });

    it('an UNSET top-level falls to the top-level default registry on every command', () => {
      const c = resolveCommands({ ...LLM });
      expect(c.ask.builtInTools).toEqual(['gth_checklist', 'gth_grep']);
      expect(c.code.builtInTools).toEqual(['gth_checklist', 'gth_grep']);
    });

    it('per-command explicit beats an explicit top-level', () => {
      const c = resolveCommands({
        ...LLM,
        builtInTools: ['gth_grep'],
        commands: { code: { builtInTools: ['gth_checklist'] } },
      });
      expect(c.code.builtInTools).toEqual(['gth_checklist']);
      expect(c.ask.builtInTools).toEqual(['gth_grep']);
    });
  });

  describe('allowedTools (no per-command or top-level default)', () => {
    it('an explicit top-level [] disables tools for every command', () => {
      const c = resolveCommands({ ...LLM, allowedTools: [] });
      for (const cmd of ALL_COMMANDS) {
        expect(c[cmd].allowedTools).toEqual([]);
      }
    });

    it('an UNSET top-level leaves the key ABSENT (no default anywhere → not written as undefined)', () => {
      const c = resolveCommands({ ...LLM });
      expect(c.ask.allowedTools).toBeUndefined();
      expect('allowedTools' in c.ask).toBe(false);
    });
  });

  describe('DEFAULT_CONFIG is never mutated (the deepMerge-returns-target trap)', () => {
    it('resolving with an explicit top-level does not poison the per-command default seen by a later resolve', () => {
      // If the fix mutated the merged command in place, `deepMerge` returns the LIVE
      // DEFAULT_CONFIG.commands.code reference for an unconfigured command, so this first resolve
      // would rewrite the shared default to 'none' for all subsequent calls.
      resolveCommands({ ...LLM, filesystem: 'none' });
      const second = resolveCommands({ ...LLM });
      expect(second.code.filesystem).toBe('all');
      expect(second.exec.filesystem).toBe('all');
      expect(second.ask.filesystem).toBe('read');
    });
  });
});
