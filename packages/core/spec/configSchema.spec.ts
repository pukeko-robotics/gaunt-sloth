import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findUnknownTopLevelKeys,
  formatConfigValidationError,
  generateConfigJsonSchema,
  preMapDeprecatedConfigNames,
  rawGthConfigSchema,
} from '#src/config/schema.js';
import { DEFAULT_CONFIG } from '#src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const committedSchemaPath = resolve(here, '../schema/gsloth-config.schema.json');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('config schema (GS2-1 B1)', () => {
  describe('parse success / failure', () => {
    it('parses a minimal valid config', () => {
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' } });
      expect(result.success).toBe(true);
    });

    it('produces a path-scoped error message on a type mismatch', () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        commands: { api: { port: '3000' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = formatConfigValidationError(result.error);
        expect(message).toContain('commands.api.port');
      }
    });

    it('reports a top-level type mismatch with a (root)-free path', () => {
      const result = rawGthConfigSchema.safeParse({ streamOutput: 'yes' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toContain('streamOutput');
      }
    });
  });

  describe('unknown top-level keys', () => {
    it('preserves unknown keys (does not strip or fail) and flags them for warning', () => {
      const raw = { llm: { type: 'openai' }, totallyMadeUpKey: 123 };
      expect(findUnknownTopLevelKeys(raw)).toEqual(['totallyMadeUpKey']);

      const result = rawGthConfigSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        // looseObject keeps the unknown key in the parsed output.
        expect((result.data as Record<string, unknown>).totallyMadeUpKey).toBe(123);
      }
    });

    it('treats $schema and every known field as known', () => {
      expect(findUnknownTopLevelKeys({ $schema: './x.json', llm: {}, commands: {} })).toEqual([]);
    });
  });

  describe('accept every known-good config', () => {
    it('accepts DEFAULT_CONFIG', () => {
      const result = rawGthConfigSchema.safeParse(DEFAULT_CONFIG);
      expect(result.success).toBe(true);
    });

    it.each([
      'examples/jira-mcp/.gsloth.config.json',
      'examples/lmstudio/.gsloth.config.json',
      'examples/a2a/.gsloth.config.json',
      'examples/simple-DIY-helper/.gsloth.config.json',
    ])('accepts %s', (relPath) => {
      const config = readJson(resolve(repoRoot, relPath));
      const result = rawGthConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    // NOTE: examples/js-config/.gsloth.config.js exports an async `configure()` and
    // returns live objects; it is exercised by the loader integration paths, not this
    // unit test, so it is intentionally skipped here.

    it('accepts a realistic consumer config (a2ui surface + api/cors)', () => {
      const config = {
        llm: {
          type: 'openai',
          model: 'gpt-5.4',
          configuration: { temperature: 0.7 },
        },
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
      const result = rawGthConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });

  describe('deprecated-name pre-map (B3)', () => {
    it('maps contentProvider to contentSource and warns', () => {
      const { config, warnings } = preMapDeprecatedConfigNames({ contentProvider: 'github' });
      expect(config.contentSource).toBe('github');
      expect('contentProvider' in config).toBe(false);
      expect(
        warnings.some((w) => w.includes('contentProvider') && w.includes('contentSource'))
      ).toBe(true);
    });

    it('maps deprecated names per command and root *Config aliases', () => {
      const { config, warnings } = preMapDeprecatedConfigNames({
        requirementsProviderConfig: { jira: { cloudId: 'X' } },
        commands: { pr: { requirementsProvider: 'jira', contentProvider: 'github' } },
      });
      expect(config.requirementSourceConfig).toEqual({ jira: { cloudId: 'X' } });
      expect('requirementsProviderConfig' in config).toBe(false);
      const pr = (config.commands as Record<string, Record<string, unknown>>).pr;
      expect(pr.requirementSource).toBe('jira');
      expect(pr.contentSource).toBe('github');
      expect('requirementsProvider' in pr).toBe(false);
      expect('contentProvider' in pr).toBe(false);
      // root *Config + two per-command keys = 3 warnings.
      expect(warnings).toHaveLength(3);
    });

    it('keeps the canonical value when both canonical and deprecated are present', () => {
      const { config } = preMapDeprecatedConfigNames({
        contentSource: 'canonical',
        contentProvider: 'deprecated',
      });
      expect(config.contentSource).toBe('canonical');
      expect('contentProvider' in config).toBe(false);
    });
  });

  describe('agent.backend selector (GS2-2 B5)', () => {
    it("accepts agent.backend 'deep' and 'lean'", () => {
      for (const backend of ['deep', 'lean'] as const) {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'openai' },
          agent: { backend },
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects an invalid agent.backend value with a path-scoped message', () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        agent: { backend: 'medium' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toContain('agent.backend');
      }
    });

    it('treats agent as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, agent: { backend: 'lean' } })).toEqual([]);
    });

    it('accepts a config that omits agent (undefined ⇒ deep)', () => {
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'openai' } });
      expect(result.success).toBe(true);
    });
  });

  describe('JSON Schema generation (golden snapshot)', () => {
    it('matches the committed schema file', () => {
      const generated = generateConfigJsonSchema();
      const committed = readJson(committedSchemaPath);
      expect(generated).toEqual(committed);
    });
  });
});
