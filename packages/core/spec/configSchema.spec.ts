import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findDeprecatedConfigIssues,
  findUnknownTopLevelKeys,
  formatConfigValidationError,
  formatDeprecatedConfigIssues,
  generateConfigJsonSchema,
  rawGthConfigSchema,
  validateRawGthConfig,
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

  describe('deprecated-shape rejection (GS2-28)', () => {
    it('flags a top-level command key, naming commands.<cmd> + migration path', () => {
      const issues = findDeprecatedConfigIssues({ llm: { type: 'openai' }, pr: { rating: {} } });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('pr');
      expect(issues[0].message).toContain('commands.pr');
      expect(issues[0].message).toContain('gth config migrate');
    });

    it('flags every command name used at the root', () => {
      const raw: Record<string, unknown> = { llm: { type: 'openai' } };
      for (const cmd of ['pr', 'review', 'ask', 'chat', 'code', 'exec', 'api']) {
        raw[cmd] = {};
      }
      const paths = findDeprecatedConfigIssues(raw).map((i) => i.path);
      expect(paths).toEqual(['pr', 'review', 'ask', 'chat', 'code', 'exec', 'api']);
    });

    it('flags deprecated *Provider* names at the root, naming the *Source* replacement', () => {
      const issues = findDeprecatedConfigIssues({
        contentProvider: 'github',
        requirementsProvider: 'jira',
        contentProviderConfig: {},
        requirementsProviderConfig: {},
      });
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
      expect(byPath.contentProvider).toContain('contentSource');
      expect(byPath.requirementsProvider).toContain('requirementSource');
      expect(byPath.contentProviderConfig).toContain('contentSourceConfig');
      expect(byPath.requirementsProviderConfig).toContain('requirementSourceConfig');
    });

    it('flags deprecated *Provider* names inside a commands.<name> block', () => {
      const issues = findDeprecatedConfigIssues({
        commands: { pr: { requirementsProvider: 'jira', contentProvider: 'github' } },
      });
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
      expect(byPath['commands.pr.requirementsProvider']).toContain('requirementSource');
      expect(byPath['commands.pr.contentProvider']).toContain('contentSource');
    });

    it('does NOT flag a genuinely-unknown key or the canonical shapes', () => {
      expect(
        findDeprecatedConfigIssues({
          llm: { type: 'openai' },
          pulrequest: {},
          contentSource: 'file',
          commands: { pr: { contentSource: 'github', requirementSource: 'jira' } },
        })
      ).toEqual([]);
    });

    it('formats issues as the same `  - <path>: <message>` block as schema errors', () => {
      const rendered = formatDeprecatedConfigIssues(
        findDeprecatedConfigIssues({ pr: {}, contentProvider: 'github' })
      );
      expect(rendered).toContain('  - pr: ');
      expect(rendered).toContain('  - contentProvider: ');
    });

    it('validateRawGthConfig hard-rejects a top-level command key (ok:false, no warning)', () => {
      const result = validateRawGthConfig({ llm: { type: 'openai' }, review: {} });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('commands.review');
      // The removed shape is rejected, not doubled as an unknown-key warning.
      expect(result.warnings).toEqual([]);
    });

    it('validateRawGthConfig hard-rejects a deprecated *Provider* name naming its *Source*', () => {
      const result = validateRawGthConfig({ llm: { type: 'openai' }, contentProvider: 'github' });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('contentSource');
    });

    it('validateRawGthConfig still WARNS (does not fail) on a genuine typo key', () => {
      const result = validateRawGthConfig({ llm: { type: 'openai' }, pulrequest: 123 });
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.includes('pulrequest'))).toBe(true);
    });

    it('validateRawGthConfig accepts the canonical shapes clean', () => {
      const result = validateRawGthConfig({
        llm: { type: 'openai' },
        contentSource: 'file',
        commands: { pr: { contentSource: 'github', rating: { enabled: false } } },
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
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
