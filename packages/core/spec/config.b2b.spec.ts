import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';
import type { RawGthConfig } from '#src/config.js';
// REAL node:path + the REAL constants the loader uses, so a path this file builds is
// byte-identical to the one production builds (OPS-27 — never a hand-written POSIX literal).
import { resolve } from 'node:path';
import { GSLOTH_DIR, GSLOTH_SETTINGS_DIR } from '#src/constants.js';

const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const urlMock = { pathToFileURL: vi.fn() };
vi.mock('node:url', () => urlMock);

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  setConsoleLevel: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fileUtilsMock = {
  writeFileIfNotExistsWithMessages: vi.fn(),
  importExternalFile: vi.fn(),
  importFromFilePath: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  toFileSafeString: vi.fn(),
  readFileSyncWithMessages: vi.fn(),
  getGslothConfigReadPath: vi.fn().mockImplementation((path: string) => `/mock/read/${path}`),
  getGslothConfigWritePath: vi.fn().mockImplementation((path: string) => `/mock/write/${path}`),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const systemUtilsMock = {
  exit: vi.fn(),
  error: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
  setProjectDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
  // CFG-30 — colour now auto-detects from stdout when nothing else decides, and consults the
  // environment. Both are declared here (empty env = neither NO_COLOR nor FORCE_COLOR set) so
  // these tests are insulated from the ambient terminal and shell.
  isStdoutTTY: vi.fn(),
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/**
 * The ABSENT-global sentinel, honouring the profile argument the production resolver takes
 * (CFG-57): a profile-scoped lookup must resolve somewhere OTHER than the unscoped path, or one
 * mocked answer covers two different asks and a scoping defect passes unseen.
 *
 * A sentinel, not a path: `node:fs` is mocked here and paths are matched by exact equality or by
 * `includes('.gsloth.config.ts')`, so it stays a plain string (a `resolve()` would be
 * drive-lettered on win32 and match nothing) and never contains a real config filename. The
 * `.gsloth-settings` segment comes from the production constant so the spelling cannot drift.
 */
const absentGlobalConfigPath = (_filename: string, identityProfile?: string): string =>
  identityProfile
    ? `/mock/global-absent/${GSLOTH_SETTINGS_DIR}/${identityProfile}/no-such-config`
    : '/mock/global-absent/no-such-config';

const globalConfigUtilsMock = {
  getGlobalGslothConfigReadPath: vi.fn().mockImplementation(absentGlobalConfigPath),
  getGlobalGslothConfigWritePath: vi
    .fn()
    .mockImplementation((filename: string) => `/mock/global-write/${filename}`),
};
vi.mock('#src/utils/globalConfigUtils.js', () => globalConfigUtilsMock);

describe('config B2b behavior changes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getProjectDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
    systemUtilsMock.isTTY.mockReturnValue(true);
    systemUtilsMock.isStdoutTTY.mockReturnValue(true);
    globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(absentGlobalConfigPath);
    fileUtilsMock.getGslothConfigReadPath.mockImplementation(
      (path: string) => `/mock/read/${path}`
    );
  });

  describe('.ts config format (Part 2)', () => {
    it('loads and validates a .ts config via async configure()', async () => {
      const mockConfig = { llm: { type: 'anthropic' } };
      // Only the .ts file exists (no json/js/mjs).
      fsMock.existsSync.mockImplementation(
        (path: string) => !!path && path.includes('.gsloth.config.ts')
      );
      fileUtilsMock.importExternalFile.mockImplementation((path: string) =>
        path.includes('.gsloth.config.ts')
          ? Promise.resolve({ configure: vi.fn().mockResolvedValue(mockConfig) })
          : Promise.reject(new Error('not found'))
      );

      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // Module formats (js/mjs/ts) arrive pre-instantiated; llm passes through unchanged.
      expect(config.llm).toEqual({ type: 'anthropic' });
      // Defaults are merged in (validated through the same Zod path as js/mjs).
      expect(config.contentSource).toBe('file');
      expect(config.streamOutput).toBe(true);
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });
  });

  describe('array merge policy (Part 3)', () => {
    const GLOBAL_JSON_PATH = '/mock/global/.gsloth.config.json';
    const PROJECT_JSON_MARKER = '.gsloth.config.json';

    function setupGlobalAndProject(
      globalConfig: Record<string, unknown>,
      projectConfig: Record<string, unknown>
    ) {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
        (filename: string, identityProfile?: string) =>
          // The global config sits at the UNSCOPED path — where a run without `--global` reads it.
          // A profile-scoped lookup must miss it rather than be served the same file.
          !identityProfile && filename === PROJECT_JSON_MARKER
            ? GLOBAL_JSON_PATH
            : absentGlobalConfigPath(filename, identityProfile)
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return true;
        return path === `/mock/read/${PROJECT_JSON_MARKER}`;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return JSON.stringify(globalConfig);
        if (path === `/mock/read/${PROJECT_JSON_MARKER}`) return JSON.stringify(projectConfig);
        return '';
      });
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
          type: 'vertexai',
          ...llm,
        })),
        postProcessJsonConfig: undefined,
      }));
    }

    it('unions + dedupes an ADDITIVE root field (allowDirs) across global → project', async () => {
      setupGlobalAndProject(
        { allowDirs: ['/a', '/shared'] },
        { llm: { type: 'vertexai' }, allowDirs: ['/b', '/shared'] }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});
      // global-first, de-duped.
      expect(config.allowDirs).toEqual(['/a', '/shared', '/b']);
    });

    it('unions + dedupes a nested ADDITIVE field (aiignore.patterns)', async () => {
      setupGlobalAndProject(
        { aiignore: { enabled: true, patterns: ['*.log', 'shared'] } },
        { llm: { type: 'vertexai' }, aiignore: { patterns: ['*.tmp', 'shared'] } }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});
      expect(config.aiignore).toEqual({ enabled: true, patterns: ['*.log', 'shared', '*.tmp'] });
    });

    it('REPLACES a non-additive array field (builtInTools) — project wins, no union', async () => {
      setupGlobalAndProject(
        { builtInTools: ['globalTool'] },
        { llm: { type: 'vertexai' }, builtInTools: ['projectTool'] }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});
      expect(config.builtInTools).toEqual(['projectTool']);
    });
  });

  /**
   * §9.1/§11.1f — the CROSS-LAYER half of "the three approvals rule lists never replace, they
   * concatenate across every scope". These drive a genuine two-layer LOAD (a global config file
   * underlaying a project one, through `applyGlobalConfigBase` → `deepMerge`) because that is
   * where the merge policy lives: a test that hands `resolveApprovals` a pre-built config object
   * skips the merge entirely and cannot see this half at all.
   *
   * Asserted as DECISIONS through the one comparison engine, so they pin what the gate does rather
   * than which array survived, and are blind to concatenation order.
   */
  describe('approvals rule lists across config layers (§9.1/§11.1f)', () => {
    const GLOBAL_JSON_PATH = '/mock/global/.gsloth.config.json';
    const PROJECT_JSON_MARKER = '.gsloth.config.json';

    const GLOBAL_DENY = { type: 'shell', matcher: 'glob', pattern: 'npm publish*' };
    const PROJECT_DENY = { type: 'shell', matcher: 'glob', pattern: 'git push --force*' };

    function setupGlobalAndProject(
      globalConfig: Record<string, unknown>,
      projectConfig: Record<string, unknown>
    ) {
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
        (filename: string, identityProfile?: string) =>
          // The global config sits at the UNSCOPED path — where a run without `--global` reads it.
          // A profile-scoped lookup must miss it rather than be served the same file.
          !identityProfile && filename === PROJECT_JSON_MARKER
            ? GLOBAL_JSON_PATH
            : absentGlobalConfigPath(filename, identityProfile)
      );
      fileUtilsMock.getGslothConfigReadPath.mockImplementation(
        (filename: string) => `/mock/read/${filename}`
      );
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return true;
        return path === `/mock/read/${PROJECT_JSON_MARKER}`;
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === GLOBAL_JSON_PATH) return JSON.stringify(globalConfig);
        if (path === `/mock/read/${PROJECT_JSON_MARKER}`) return JSON.stringify(projectConfig);
        return '';
      });
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
          type: 'vertexai',
          ...llm,
        })),
        postProcessJsonConfig: undefined,
      }));
    }

    /** What the loaded config's posture for `command` decides about a shell command. */
    async function decide(config: unknown, command: 'code' | 'review', shellCommand: string) {
      const { resolveApprovals } = await import('#src/config/shell-policy.js');
      const { resolveApprovalRules } = await import('#src/core/approvals/matcher.js');
      const approvals = resolveApprovals(config as Parameters<typeof resolveApprovals>[0], command);
      return {
        rung: approvals.rung,
        action: resolveApprovalRules(
          { kind: 'shell', command: shellCommand },
          { allow: approvals.allow, deny: approvals.deny, escalate: approvals.escalate }
        )?.action,
      };
    }

    it('a project deny list ADDS to the global one rather than replacing it', async () => {
      setupGlobalAndProject(
        { approvals: { mode: 'assisted', deny: [GLOBAL_DENY] } },
        {
          llm: { type: 'vertexai' },
          approvals: { mode: 'bypass', deny: [PROJECT_DENY] },
        }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // CONTROL — the project layer DID win where it is supposed to: `mode` is a scalar and the
      // higher-precedence layer replaces it. Without this the deny assertions below would pass on
      // a merge that ignored the project layer altogether.
      expect((await decide(config, 'code', 'npm test')).rung).toBe('bypass');
      // Both layers' prohibitions bite…
      expect((await decide(config, 'code', 'npm publish --access public')).action).toBe('deny');
      expect((await decide(config, 'code', 'git push --force origin main')).action).toBe('deny');
      // …and the union did not widen into a refuse-everything.
      expect((await decide(config, 'code', 'npm test')).action).toBeUndefined();
      // CONTROL — the merge succeeded rather than falling back to one layer after a swallowed
      // validation failure, which would leave a passing assertion meaning nothing.
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    it('a PER-COMMAND deny list adds across layers too, not only the root one', async () => {
      // The same rule one level down. Listing only the root path in the merge policy would leave
      // the identical silent loss one keystroke away.
      setupGlobalAndProject(
        { commands: { code: { approvals: { mode: 'assisted', deny: [GLOBAL_DENY] } } } },
        {
          llm: { type: 'vertexai' },
          commands: { code: { approvals: { mode: 'bypass', deny: [PROJECT_DENY] } } },
        }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect((await decide(config, 'code', 'npm test')).rung).toBe('bypass');
      expect((await decide(config, 'code', 'npm publish --access public')).action).toBe('deny');
      expect((await decide(config, 'code', 'git push --force origin main')).action).toBe('deny');
      // CONTROL — this is a per-COMMAND block: another command inherits neither entry.
      expect(
        (await decide(config, 'review', 'npm publish --access public')).action
      ).toBeUndefined();
      // CONTROL — the merge succeeded rather than falling back to one layer after a swallowed
      // validation failure. Both layers' entries could otherwise be an accident of the fallback.
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    /**
     * The composition case, and the only one that needs BOTH halves of the fix at once: the
     * prohibition arrives from the global layer at the ROOT, the rung and a second prohibition from
     * the project layer PER COMMAND. Cross-layer merge alone leaves the root list to be discarded
     * by the per-command block; the resolver's concatenation alone never sees the global layer.
     * It is also the likeliest shape of a config someone actually writes — a personal deny list at
     * `~/.gsloth`, a project that loosens one command.
     */
    it('a global ROOT deny and a project PER-COMMAND deny both bite for that command', async () => {
      setupGlobalAndProject(
        { approvals: { mode: 'assisted', deny: [GLOBAL_DENY] } },
        {
          llm: { type: 'vertexai' },
          commands: { code: { approvals: { mode: 'bypass', deny: [PROJECT_DENY] } } },
        }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // CONTROL — the per-command rung took effect, so this is a statement about `bypass`.
      expect((await decide(config, 'code', 'npm test')).rung).toBe('bypass');
      expect((await decide(config, 'code', 'npm publish --access public')).action).toBe('deny');
      expect((await decide(config, 'code', 'git push --force origin main')).action).toBe('deny');
      expect((await decide(config, 'code', 'npm test')).action).toBeUndefined();

      // CONTROL — the other direction of scope: `review` has no per-command block, so it keeps the
      // global root rung and the global entry, and never sees the project's command-specific one.
      const review = await decide(config, 'review', 'git push --force origin main');
      expect(review.rung).toBe('assisted');
      expect(review.action).toBeUndefined();
      expect((await decide(config, 'review', 'npm publish --access public')).action).toBe('deny');

      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    /**
     * §9.1 — `allow` is the PERMISSIVE list and therefore keeps REPLACE semantics across layers
     * too: a layer that states its own replaces the layer below, one that says nothing inherits.
     * Unioning it here would fail toward an execution, which is the whole reason it is not in the
     * additive set (§3.1's cost asymmetry).
     */
    it('a project allow list REPLACES the global one, while deny still adds', async () => {
      setupGlobalAndProject(
        {
          approvals: {
            mode: 'assisted',
            allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
            deny: [GLOBAL_DENY],
          },
        },
        {
          llm: { type: 'vertexai' },
          approvals: {
            allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm run build' }],
            deny: [PROJECT_DENY],
          },
        }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      // The project's own allow list is in force; the global's is gone.
      expect((await decide(config, 'code', 'npm run build')).action).toBe('allow');
      expect((await decide(config, 'code', 'npm test')).action).toBeUndefined();
      // CONTROL — the permissive list narrowed WITHOUT the restrictive one narrowing with it.
      // The two policies live one line apart; this is what stops a future edit unifying them.
      expect((await decide(config, 'code', 'npm publish --access public')).action).toBe('deny');
      expect((await decide(config, 'code', 'git push --force origin main')).action).toBe('deny');
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    /**
     * EXT-70 §4.7 — `trustAnnotations` is a list, so it lands on the merge policy's DEFAULT
     * (replace) rather than in the additive set. That is what makes `[]` mean "believe nothing":
     * were it additive, a project config could not withdraw a global one's trust at all, and the
     * fail-closed spelling would silently be the one shape the merge cannot express.
     *
     * Asserted through the effective annotation set, so it pins what the gate believes rather than
     * which array survived the merge.
     */
    describe('the approvals.mcp trust block across layers (EXT-70 §4.7)', () => {
      /** Whether jira's declared `readOnlyHint: true` survives into the effective set. */
      async function jiraReadOnly(config: unknown): Promise<boolean> {
        const { resolveApprovals } = await import('#src/config/shell-policy.js');
        const { createEffectiveToolAnnotationSource } =
          await import('#src/core/approvals/annotations.js');
        const approvals = resolveApprovals(
          config as Parameters<typeof resolveApprovals>[0],
          'code'
        );
        return createEffectiveToolAnnotationSource({
          mcp: approvals.mcp,
          declared: { mcp: () => ({ readOnlyHint: true }) },
        })({ kind: 'mcpTool', server: 'jira', name: 'get_issue' }).readOnlyHint;
      }

      it('a project layer WITHDRAWS a global one’s trust with an empty list', async () => {
        setupGlobalAndProject(
          {
            approvals: {
              mode: 'assisted',
              mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
              deny: [GLOBAL_DENY],
            },
          },
          {
            llm: { type: 'vertexai' },
            approvals: { mcp: { servers: { jira: { trustAnnotations: [] } } } },
          }
        );
        const { initConfig } = await import('#src/config.js');
        const config = await initConfig({});

        expect(await jiraReadOnly(config)).toBe(false);
        // CONTROL — the restrictive list did not narrow along with the trust.
        expect((await decide(config, 'code', 'npm publish --access public')).action).toBe('deny');
        expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      });

      it('a project layer that states NO mcp inherits the global block', async () => {
        // The other direction, without which the test above pins only "the global block went away".
        setupGlobalAndProject(
          {
            approvals: {
              mode: 'assisted',
              mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
            },
          },
          { llm: { type: 'vertexai' }, approvals: { mode: 'write' } }
        );
        const { initConfig } = await import('#src/config.js');
        const config = await initConfig({});

        expect((await decide(config, 'code', 'npm test')).rung).toBe('write'); // CONTROL
        expect(await jiraReadOnly(config)).toBe(true);
      });
    });

    it('a project layer that states NO allow inherits the global one', async () => {
      // The other direction, without which the test above pins only "the global list went away".
      setupGlobalAndProject(
        {
          approvals: {
            mode: 'assisted',
            allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
          },
        },
        { llm: { type: 'vertexai' }, approvals: { mode: 'write' } }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect((await decide(config, 'code', 'npm test')).rung).toBe('write'); // CONTROL
      expect((await decide(config, 'code', 'npm test')).action).toBe('allow');
    });

    it('a project SCALAR rung keeps the global lists — the scalar is sugar for { mode }', async () => {
      // §9.1's union collapsing is a second route to the same loss: a bare string on the
      // higher-precedence layer would otherwise overwrite the lower layer's whole block.
      setupGlobalAndProject(
        { approvals: { mode: 'assisted', rater: 'safety-rater', deny: [GLOBAL_DENY] } },
        { llm: { type: 'vertexai' }, approvals: 'bypass' }
      );
      // CFG-36 — `approvals.rater` is resolved against the filesystem as the layer is validated, and
      // an unresolvable one is a hard config error. Give the named profile a real config so this
      // fixture is a config a run could actually load; without it the test would only pass because
      // the mocked `exit` let the loader fall through a branch production terminates on. Built with
      // the real `resolve()` from the same mocked cwd the loader walks (OPS-27) — never a literal.
      const RATER_PROFILE_CONFIG = resolve(
        '/mock/current/dir',
        GSLOTH_DIR,
        GSLOTH_SETTINGS_DIR,
        'safety-rater',
        PROJECT_JSON_MARKER
      );
      fsMock.existsSync.mockImplementation(
        (path: string) =>
          path === GLOBAL_JSON_PATH ||
          path === `/mock/read/${PROJECT_JSON_MARKER}` ||
          path === RATER_PROFILE_CONFIG
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect((await decide(config, 'code', 'npm test')).rung).toBe('bypass');
      expect((await decide(config, 'code', 'npm publish --access public')).action).toBe('deny');
    });

    it('a lone approvals value is left EXACTLY as written — no normalization, no churn', async () => {
      // The scalar is expanded only where a field would otherwise be lost, so the overwhelmingly
      // common single-layer config keeps the literal value the user typed — and `gth config print`
      // and the `/config` panel with it.
      setupGlobalAndProject(
        { allowDirs: ['/a'] },
        { llm: { type: 'vertexai' }, approvals: 'write' }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(config.approvals).toBe('write');
    });

    it('two scalar layers stay a scalar — the project rung wins, the shape does not change', async () => {
      // Neither layer carries a list, so there is nothing to preserve and nothing to expand.
      setupGlobalAndProject(
        { approvals: 'assisted' },
        { llm: { type: 'vertexai' }, approvals: 'bypass' }
      );
      const { initConfig } = await import('#src/config.js');
      const config = await initConfig({});

      expect(config.approvals).toBe('bypass');
    });
  });

  describe('merge purity (resolveConfig has no console side-effects)', () => {
    it('resolveConfig resolves values WITHOUT calling setUseColour / setConsoleLevel', async () => {
      const { resolveConfig } = await import('#src/config/loader.js');
      const result = resolveConfig(
        { llm: { type: 'x' }, useColour: true, consoleLevel: 'debug' } as unknown as RawGthConfig,
        {}
      );
      // The pure resolver computes the numeric level...
      expect(result.consoleLevel).toBe(StatusLevel.DEBUG);
      // ...but applies NO process-global side effects (those live in the mergeConfig wrapper).
      expect(systemUtilsMock.setUseColour).not.toHaveBeenCalled();
      expect(consoleUtilsMock.setConsoleLevel).not.toHaveBeenCalled();
    });
  });
});
