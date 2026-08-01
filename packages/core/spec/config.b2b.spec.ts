import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';
import type { RawGthConfig } from '#src/config.js';

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

const globalConfigUtilsMock = {
  getGlobalGslothConfigReadPath: vi
    .fn()
    .mockImplementation(() => '/mock/global-absent/no-such-config'),
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
    globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
      () => '/mock/global-absent/no-such-config'
    );
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
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation((filename: string) =>
        filename === PROJECT_JSON_MARKER ? GLOBAL_JSON_PATH : `/mock/global-absent/${filename}`
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
      globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation((filename: string) =>
        filename === PROJECT_JSON_MARKER ? GLOBAL_JSON_PATH : `/mock/global-absent/${filename}`
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
        { approvals: { mode: 'auto-safe', deny: [GLOBAL_DENY] } },
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
        { commands: { code: { approvals: { mode: 'auto-safe', deny: [GLOBAL_DENY] } } } },
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
        { approvals: { mode: 'auto-safe', deny: [GLOBAL_DENY] } },
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
      expect(review.rung).toBe('auto-safe');
      expect(review.action).toBeUndefined();
      expect((await decide(config, 'review', 'npm publish --access public')).action).toBe('deny');

      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    it('a project SCALAR rung keeps the global lists — the scalar is sugar for { mode }', async () => {
      // §9.1's union collapsing is a second route to the same loss: a bare string on the
      // higher-precedence layer would otherwise overwrite the lower layer's whole block.
      setupGlobalAndProject(
        { approvals: { mode: 'auto-safe', rater: 'safety-rater', deny: [GLOBAL_DENY] } },
        { llm: { type: 'vertexai' }, approvals: 'bypass' }
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
        { approvals: 'auto-safe' },
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
