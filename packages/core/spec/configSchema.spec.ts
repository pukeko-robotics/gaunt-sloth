import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findApprovalsRaterProfiles,
  findDeprecatedConfigIssues,
  findUnknownTopLevelKeys,
  formatConfigValidationError,
  formatDeprecatedConfigIssues,
  generateConfigJsonSchema,
  rawGthConfigSchema,
  unresolvedRaterProfileMessage,
  validateRawGthConfig,
} from '#src/config/schema.js';
import { DEFAULT_CONFIG } from '#src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const committedSchemaPath = resolve(here, '../schema/gsloth-config.schema.json');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The migration-doc URL every deprecated-shape message must carry (GS2-70) — a deliberate
 * copy of schema.ts's MIGRATION_HINT link, so a wording change is a conscious two-place edit.
 */
const MIGRATION_DOC_URL =
  'https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/MIGRATION.md';

describe('config schema (GS2-1 B1)', () => {
  describe('parse success / failure', () => {
    it('parses a minimal valid config', () => {
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' } });
      expect(result.success).toBe(true);
    });

    it('GS2-63: accepts output.header and rejects a non-boolean header', () => {
      expect(
        rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' }, output: { header: false } })
          .success
      ).toBe(true);
      const bad = rawGthConfigSchema.safeParse({
        llm: { type: 'anthropic' },
        output: { header: 'nope' },
      });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('output.header');
      }
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

    // GS2-35 — the config-driven commit co-author identity.
    it('accepts commit.coAuthor and rejects a non-string name', () => {
      expect(
        rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          commit: { coAuthor: { name: 'Acme Bot', email: 'bot@acme.test' } },
        }).success
      ).toBe(true);
      // A partial identity (either field alone) is valid; both fields are optional.
      expect(
        rawGthConfigSchema.safeParse({ commit: { coAuthor: { name: 'Only Name' } } }).success
      ).toBe(true);
      const bad = rawGthConfigSchema.safeParse({ commit: { coAuthor: { name: 123 } } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('commit.coAuthor.name');
      }
    });

    // GS2-34 — the model-context injection opt-out toggle. Boolean-only; the default (omitted =
    // inject-on) is a READ-SITE default (like GS2-35's commit.coAuthor), proven behaviorally in the
    // injection parity spec, so it is intentionally NOT a schema/DEFAULT_CONFIG default here.
    it('accepts injectModelContext as a boolean and rejects a non-boolean', () => {
      expect(rawGthConfigSchema.safeParse({ injectModelContext: true }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ injectModelContext: false }).success).toBe(true);
      const bad = rawGthConfigSchema.safeParse({ injectModelContext: 'yes' });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('injectModelContext');
      }
    });

    // EXT-36 — the tool-loop guard knob. Boolean (false disables / true = warn-on) OR the
    // fine-grained { warn, halt, threshold } object; a wrong type is a path-scoped failure. Like
    // injectModelContext the WARN-on default is a READ-SITE default, so it is intentionally NOT a
    // schema/DEFAULT_CONFIG default here.
    it('accepts toolLoopGuard as a boolean or a { warn, halt, threshold } object', () => {
      expect(rawGthConfigSchema.safeParse({ toolLoopGuard: false }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ toolLoopGuard: true }).success).toBe(true);
      expect(
        rawGthConfigSchema.safeParse({ toolLoopGuard: { warn: true, halt: true, threshold: 4 } })
          .success
      ).toBe(true);
      // Partial object forms are valid (every field optional).
      expect(rawGthConfigSchema.safeParse({ toolLoopGuard: { halt: true } }).success).toBe(true);
    });

    it('rejects a non-numeric toolLoopGuard.threshold with a path-scoped message', () => {
      const bad = rawGthConfigSchema.safeParse({ toolLoopGuard: { threshold: 'lots' } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('toolLoopGuard');
      }
    });

    it('treats toolLoopGuard as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, toolLoopGuard: { halt: true } })).toEqual([]);
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

  // CFG-18: the golden snapshot pins the schema SHAPE; these assert the schema→resolver VALUE seam —
  // a full builtInTools registry parses through the real schema and preserves every field (not only
  // the hand-built resolver object).
  describe('builtInTools registry round-trip (CFG-18)', () => {
    it('parses a full run_shell_command config and preserves every field', () => {
      // CFG-26 — the run_shell_command entry now carries EXECUTION knobs only; the approval knobs
      // moved to the top-level `approvals` block (see the CFG-26 describe below).
      const builtInTools = {
        gth_checklist: true,
        run_tests: { command: 'npm test' },
        run_shell_command: {
          enabled: true,
          timeout: 300000,
          maxOutputBytes: 200000,
        },
      };
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'openai' }, builtInTools });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).builtInTools).toEqual(builtInTools);
      }
    });

    it('parses the boolean-in-record force-disable arm ({ run_shell_command: false })', () => {
      const builtInTools = { run_shell_command: false, gth_checklist: true };
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'openai' }, builtInTools });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).builtInTools).toEqual(builtInTools);
      }
    });
  });

  describe('deprecated-shape rejection (GS2-28)', () => {
    it('flags a top-level command key, naming commands.<cmd> + migration path', () => {
      const issues = findDeprecatedConfigIssues({ llm: { type: 'openai' }, pr: { rating: {} } });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('pr');
      expect(issues[0].message).toContain('commands.pr');
      expect(issues[0].message).toContain(MIGRATION_DOC_URL);
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

    it('flags a removed per-command devTools key, naming builtInTools + the migration path (CFG-18)', () => {
      const issues = findDeprecatedConfigIssues({
        llm: { type: 'openai' },
        commands: { code: { devTools: { run_tests: 'npm test' } } },
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('commands.code.devTools');
      expect(issues[0].message).toContain('no longer supported in 2.0');
      expect(issues[0].message).toContain('builtInTools');
      expect(issues[0].message).toContain(MIGRATION_DOC_URL);
    });

    it('validateRawGthConfig HARD-rejects commands.<cmd>.devTools (NOT a silent strip)', () => {
      const result = validateRawGthConfig({
        llm: { type: 'openai' },
        commands: { exec: { devTools: { run_shell_command: { yolo: true } } } },
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('commands.exec.devTools');
      expect(result.errorMessage).toContain('builtInTools');
      // The removed shape is rejected, not doubled as an unknown-key warning.
      expect(result.warnings).toEqual([]);
    });

    /**
     * CFG-26 — the four retired approval knobs moved off the SHARED per-tool object onto the
     * top-level `approvals` block. They must be hard errors that NAME the new key at BOTH
     * locations they could be written (root and per-command), because `builtInToolConfigSchema`
     * is a strict `z.object`: once the field is gone zod silently STRIPS it, and a config would
     * run with its approval posture quietly ignored.
     */
    describe('retired run_shell_command approval knobs (CFG-26)', () => {
      // CFG-27 rescaled the replacements these messages name: the rung IS the setting, so
      // `yolo` points at the `bypass` rung, `allowlist` at the declared `approvals.allow` list,
      // and `persistAllowlist` at nothing (persistence is a per-decision choice now).
      const RETIRED = {
        yolo: '"approvals": "bypass"',
        judge: 'approvals.rater',
        allowlist: 'approvals.allow',
        persistAllowlist: 'per-decision choice at the approval prompt',
      } as const;

      for (const [key, replacement] of Object.entries(RETIRED)) {
        it(`flags ${key} at the ROOT builtInTools registry, naming ${replacement}`, () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            builtInTools: { run_shell_command: { enabled: true, [key]: true } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe(`builtInTools.run_shell_command.${key}`);
          expect(issues[0].message).toContain('no longer supported in 2.0');
          expect(issues[0].message).toContain(replacement);
          expect(issues[0].message).toContain(MIGRATION_DOC_URL);
        });

        it(`flags ${key} at commands.<cmd>.builtInTools, naming ${replacement}`, () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            commands: { code: { builtInTools: { run_shell_command: { [key]: true } } } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe(`commands.code.builtInTools.run_shell_command.${key}`);
          expect(issues[0].message).toContain(replacement);
        });

        it(`validateRawGthConfig HARD-rejects ${key} (never a silent strip)`, () => {
          const result = validateRawGthConfig({
            llm: { type: 'openai' },
            builtInTools: { run_shell_command: { [key]: true } },
          });
          expect(result.ok).toBe(false);
          expect(result.errorMessage).toContain(`builtInTools.run_shell_command.${key}`);
          expect(result.errorMessage).toContain(replacement);
          expect(result.warnings).toEqual([]);
        });
      }

      it('the retired judge message names the RUNG that replaced the low/medium/high knobs', () => {
        const issues = findDeprecatedConfigIssues({
          builtInTools: {
            run_shell_command: { judge: { autoApproveLow: false, blockHigh: true } },
          },
        });
        expect(issues[0].message).toContain('auto-safe');
        expect(issues[0].message).toContain('full-auto');
        expect(issues[0].message).toContain('safe/destructive/catastrophic/attack');
      });

      it('reports EVERY retired knob present, not just the first', () => {
        const issues = findDeprecatedConfigIssues({
          builtInTools: {
            run_shell_command: {
              yolo: true,
              judge: true,
              allowlist: false,
              persistAllowlist: false,
            },
          },
        });
        expect(issues.map((i) => i.path).sort()).toEqual([
          'builtInTools.run_shell_command.allowlist',
          'builtInTools.run_shell_command.judge',
          'builtInTools.run_shell_command.persistAllowlist',
          'builtInTools.run_shell_command.yolo',
        ]);
      });

      it('does not fire on the legacy string[] builtInTools form, or on another tool', () => {
        expect(
          findDeprecatedConfigIssues({
            builtInTools: ['run_shell_command', 'gth_grep'],
          })
        ).toEqual([]);
        // `gth_grep: { yolo: true }` used to VALIDATE — the knob was on the shared object. It is
        // now simply an unknown key on that tool's entry (stripped), not a run_shell_command knob.
        expect(findDeprecatedConfigIssues({ builtInTools: { gth_grep: { yolo: true } } })).toEqual(
          []
        );
      });
    });

    /**
     * CFG-27 — the `approvals` value itself: the scalar-or-object union, what the enum refuses,
     * and the retired keys / retired mode values that must hard-error naming the rung.
     */
    describe('approvals (CFG-27 ladder)', () => {
      const parse = (approvals: unknown) =>
        rawGthConfigSchema.safeParse({ llm: { type: 'openai' }, approvals });

      const RUNGS = ['read-only', 'write', 'auto-safe', 'full-auto', 'bypass'] as const;

      it.each(RUNGS)('accepts the bare rung name "%s" (§9.1 scalar sugar)', (rung) => {
        const result = parse(rung);
        expect(result.success).toBe(true);
        if (result.success) {
          expect((result.data as Record<string, unknown>).approvals).toBe(rung);
        }
      });

      it('parses a full valid object and preserves every field', () => {
        const approvals = {
          mode: 'auto-safe',
          rater: 'safety-rater',
          allow: ['npm test', 'git status'],
          deny: ['git push --force', 'npm publish'],
        };
        const result = parse(approvals);
        expect(result.success).toBe(true);
        if (result.success) {
          expect((result.data as Record<string, unknown>).approvals).toEqual(approvals);
        }
      });

      it('rejects an unknown rung, in either form', () => {
        expect(parse('yolo').success).toBe(false);
        expect(parse({ mode: 'yolo' }).success).toBe(false);
      });

      it('rejects a rater that is not a bare string (the object/boolean forms are retired)', () => {
        expect(parse({ mode: 'auto-safe', rater: { profile: 'x' } }).success).toBe(false);
        expect(parse({ mode: 'auto-safe', rater: true }).success).toBe(false);
      });

      it('parses per-command approvals on every command, scalar and object alike', () => {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'openai' },
          commands: {
            pr: { approvals: 'read-only' },
            review: { approvals: 'read-only' },
            ask: { approvals: { mode: 'write' } },
            chat: { approvals: 'auto-safe' },
            code: { approvals: { mode: 'auto-safe', rater: 'safety-rater' } },
            exec: { approvals: 'bypass' },
            api: { approvals: 'read-only' },
          },
        });
        expect(result.success).toBe(true);
      });

      /**
       * The CFG-26 migration UX, rescaled: a retired key or a retired `mode` VALUE is a hard
       * error naming the rung that replaced it. `approvalsSchema`'s object arm is a `z.object`,
       * which silently STRIPS unknown keys — so without the pre-parse reject an
       * `approvals: { mode: "auto-safe", strictness: "strict" }` would run with its declared
       * posture quietly ignored, which is the worst possible failure for a safety gate.
       */
      describe('retired approvals keys and mode values (CFG-27)', () => {
        const RETIRED_KEYS = ['strictness', 'escalate', 'allowlist', 'persistAllowlist'] as const;

        for (const key of RETIRED_KEYS) {
          it(`hard-errors on ${key} at the ROOT approvals value`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: { mode: 'auto-safe', [key]: 'whatever' },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe(`approvals.${key}`);
            expect(issues[0].message).toContain('no longer supported');
            // The message NAMES the ladder, so the user learns what replaced the knob.
            expect(issues[0].message).toContain('read-only, write, auto-safe, full-auto, bypass');
            expect(issues[0].message).toContain(MIGRATION_DOC_URL);
          });

          it(`hard-errors on ${key} at commands.<cmd>.approvals too`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              commands: { code: { approvals: { mode: 'auto-safe', [key]: 'whatever' } } },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe(`commands.code.approvals.${key}`);
          });

          it(`validateRawGthConfig HARD-rejects ${key} (never a silent strip)`, () => {
            const result = validateRawGthConfig({
              llm: { type: 'openai' },
              approvals: { mode: 'auto-safe', [key]: 'whatever' },
            });
            expect(result.ok).toBe(false);
            expect(result.errorMessage).toContain(`approvals.${key}`);
            expect(result.warnings).toEqual([]);
          });
        }

        const RETIRED_MODES = {
          auto: 'auto-safe',
          ask: 'write',
        } as const;

        for (const [retired, rung] of Object.entries(RETIRED_MODES)) {
          it(`hard-errors on the retired mode "${retired}", naming ${rung}`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: { mode: retired },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe('approvals.mode');
            expect(issues[0].message).toContain(rung);
            expect(issues[0].message).toContain('ladder of five rungs');
          });

          it(`hard-errors on the retired SCALAR "${retired}" too, naming ${rung}`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: retired,
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe('approvals');
            expect(issues[0].message).toContain(rung);
          });

          it(`hard-errors on the retired mode "${retired}" per command`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              commands: { pr: { approvals: retired } },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe('commands.pr.approvals');
          });
        }

        it('hard-errors on the retired OBJECT rater form, pointing at the bare profile name', () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            approvals: { mode: 'auto-safe', rater: { profile: 'safety-rater' } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe('approvals.rater');
          expect(issues[0].message).toContain('bare identity-profile name');
        });

        it('reports EVERY retired key present, not just the first', () => {
          const issues = findDeprecatedConfigIssues({
            approvals: { mode: 'auto', strictness: 'strict', escalate: 'danger' },
          });
          expect(issues.map((i) => i.path).sort()).toEqual([
            'approvals.escalate',
            'approvals.mode',
            'approvals.strictness',
          ]);
        });

        it('does not fire on a valid ladder config, scalar or object', () => {
          expect(findDeprecatedConfigIssues({ approvals: 'auto-safe' })).toEqual([]);
          expect(
            findDeprecatedConfigIssues({
              approvals: { mode: 'full-auto', rater: 'safety-rater', allow: ['npm test'] },
            })
          ).toEqual([]);
        });
      });

      /**
       * The emitted JSON Schema feeds the hosted /schema/v2/ + /schema/alpha/ channels, so the
       * union must be describable there. CFG-27 leaves NO refinement on `approvals` at all — with
       * `rater` flattened to a bare string and `rater: false` gone there is no coupling rule left
       * to enforce — so what is checked here is that the union itself emitted correctly.
       */
      describe('the emitted JSON Schema', () => {
        it('emits the scalar|object union as an anyOf, with no refinement leakage', () => {
          const generated = generateConfigJsonSchema();
          const approvals = (generated.properties as Record<string, Record<string, unknown>>)
            .approvals;
          expect(Object.keys(approvals)).toEqual(['anyOf']);
          const arms = approvals.anyOf as Array<Record<string, unknown>>;
          expect(arms).toHaveLength(2);
          expect(arms[0].enum).toEqual([...RUNGS]);
          expect(Object.keys(arms[1].properties as object).sort()).toEqual([
            'allow',
            'deny',
            'mode',
            'rater',
            'raterTimeoutMs',
          ]);
          // A refinement has no JSON Schema representation; nothing of that shape may appear.
          expect(JSON.stringify(approvals)).not.toContain('not');
          expect(JSON.stringify(approvals)).not.toContain('allOf');
        });

        it('describes approvals in ALL EIGHT positions (root + each per-command block)', () => {
          const generated = generateConfigJsonSchema() as Record<string, any>;
          const positions = [generated.properties.approvals];
          const commands = generated.properties.commands.properties as Record<string, any>;
          for (const name of Object.keys(commands)) {
            positions.push(commands[name].properties.approvals);
          }
          expect(positions).toHaveLength(8);
          for (const position of positions) {
            expect(position.anyOf).toHaveLength(2);
            expect(position.anyOf[0].enum).toEqual([...RUNGS]);
          }
        });
      });
    });

    /**
     * CFG-26 — `approvals.rater.profile` references, collected purely so the LOADER can enforce
     * GS2-62 strict resolution against the filesystem.
     */
    /**
     * CFG-26 Task 2 — `gth config validate` must agree with the loader. Before this, the read-side
     * validator had no profile check at all, so it green-lit a config the very next real run
     * hard-exits on: a validator that passes what the runtime refuses is worse than none. The
     * resolver is INJECTED so `schema.ts` stays pure.
     */
    describe('validateRawGthConfig + approvals.rater resolution (CFG-26, flattened by CFG-27)', () => {
      const config = {
        llm: { type: 'openai' },
        approvals: { mode: 'auto-safe', rater: 'safety-rater' },
      };

      it('rejects an unresolvable rater profile, naming the path and the profile', () => {
        const result = validateRawGthConfig(config, { resolveProfile: () => false });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('approvals.rater');
        expect(result.errorMessage).toContain('identity profile "safety-rater" not found');
      });

      it('accepts it when the profile resolves', () => {
        expect(validateRawGthConfig(config, { resolveProfile: () => true }).ok).toBe(true);
      });

      it('checks per-command profiles too', () => {
        const result = validateRawGthConfig(
          {
            llm: { type: 'openai' },
            commands: { code: { approvals: { rater: 'nope' } } },
          },
          { resolveProfile: () => false }
        );
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('commands.code.approvals.rater');
      });

      it('skips the check entirely with no resolver, so pure/in-memory callers are unaffected', () => {
        // The profile scaffolder validates a config it is about to WRITE; it has no business
        // touching the filesystem to do it.
        expect(validateRawGthConfig(config).ok).toBe(true);
      });

      it('shares ONE message with the loader, so the two surfaces cannot drift', () => {
        const result = validateRawGthConfig(config, { resolveProfile: () => false });
        expect(result.errorMessage).toContain(
          unresolvedRaterProfileMessage({ path: 'approvals.rater', profile: 'safety-rater' })
        );
      });
    });

    describe('findApprovalsRaterProfiles (CFG-26)', () => {
      it('collects root and per-command profile references with their config paths', () => {
        expect(
          findApprovalsRaterProfiles({
            approvals: { rater: 'root-rater' },
            commands: {
              code: { approvals: { rater: 'code-rater' } },
              exec: { approvals: 'write' },
            },
          })
        ).toEqual([
          { path: 'approvals.rater', profile: 'root-rater' },
          { path: 'commands.code.approvals.rater', profile: 'code-rater' },
        ]);
      });

      it('ignores an absent / blank / non-string rater, and the scalar sugar form', () => {
        expect(findApprovalsRaterProfiles({ approvals: { mode: 'auto-safe' } })).toEqual([]);
        expect(findApprovalsRaterProfiles({ approvals: 'auto-safe' })).toEqual([]);
        expect(findApprovalsRaterProfiles({ approvals: { rater: true } })).toEqual([]);
        expect(findApprovalsRaterProfiles({ approvals: { rater: '  ' } })).toEqual([]);
        expect(findApprovalsRaterProfiles({})).toEqual([]);
      });
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

    it('validateRawGthConfig does NOT throw on a non-object config (null/array); clean ok:false', () => {
      // A config file that is just `null` (or a module configure() returning null/an array) must
      // not throw a raw TypeError from the key scans — safeParse reports an "expected object" error.
      for (const bad of [null, [], 'oops'] as const) {
        const result = validateRawGthConfig(bad as unknown as Record<string, unknown>);
        expect(result.ok).toBe(false);
        expect(result.errorMessage?.toLowerCase()).toContain('object');
      }
    });
  });

  describe('prompts object (GS2-43)', () => {
    const SEGMENTS = ['backstory', 'guidelines', 'system', 'chat', 'code', 'exec', 'review'];

    it('accepts the string (path shorthand) form for every segment', () => {
      for (const segment of SEGMENTS) {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          prompts: { [segment]: 'SOME-FILE.md' },
        });
        expect(result.success, `string form for ${segment}`).toBe(true);
      }
    });

    it('accepts the object form ({ path, enabled, mode }) for every segment', () => {
      for (const segment of SEGMENTS) {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          prompts: { [segment]: { path: 'SOME-FILE.md', enabled: true, mode: 'append' } },
        });
        expect(result.success, `object form for ${segment}`).toBe(true);
      }
    });

    it('accepts partial object forms ({ enabled: false } alone, { path } alone)', () => {
      expect(
        rawGthConfigSchema.safeParse({ prompts: { review: { enabled: false } } }).success
      ).toBe(true);
      expect(
        rawGthConfigSchema.safeParse({ prompts: { guidelines: { path: 'AGENTS.md' } } }).success
      ).toBe(true);
    });

    it('rejects an invalid mode with a path-scoped error', () => {
      const result = rawGthConfigSchema.safeParse({
        prompts: { guidelines: { path: 'AGENTS.md', mode: 'prepend' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toContain('prompts.guidelines');
      }
    });

    it('treats prompts as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, prompts: { guidelines: 'AGENTS.md' } })).toEqual(
        []
      );
    });

    it('flags the removed flat keys, naming the prompts.* replacement + migration path', () => {
      const issues = findDeprecatedConfigIssues({
        llm: { type: 'openai' },
        projectGuidelines: 'AGENTS.md',
        projectReviewInstructions: 'REVIEW.md',
      });
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
      expect(byPath.projectGuidelines).toContain('prompts.guidelines');
      expect(byPath.projectGuidelines).toContain(MIGRATION_DOC_URL);
      expect(byPath.projectReviewInstructions).toContain('prompts.review');
      expect(byPath.projectReviewInstructions).toContain(MIGRATION_DOC_URL);
    });

    it('validateRawGthConfig HARD-rejects each removed flat key (ok:false, no warning)', () => {
      for (const [removed, replacement] of [
        ['projectGuidelines', 'prompts.guidelines'],
        ['projectReviewInstructions', 'prompts.review'],
      ] as const) {
        const result = validateRawGthConfig({ llm: { type: 'openai' }, [removed]: 'X.md' });
        expect(result.ok, removed).toBe(false);
        expect(result.errorMessage).toContain(removed);
        expect(result.errorMessage).toContain(replacement);
        // Rejected as a removed shape — never doubled as an unknown-key warning.
        expect(result.warnings).toEqual([]);
      }
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
