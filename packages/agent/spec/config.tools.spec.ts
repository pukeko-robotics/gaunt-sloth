import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultTools } from '#src/builtInToolsConfig.js';
import {
  DEFAULT_CONFIG,
  isFilesystemToolRegistered,
  WRITE_FILE_TOOL_NAME,
  type FilesystemToolsConfig,
} from '#src/config.js';
import type { GthConfig } from '#src/config.js';

const consoleUtilsMock = vi.hoisted(() => ({
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock the GthFileSystemToolkit
vi.mock('#src/tools/GthFileSystemToolkit.js', () => ({
  default: class MockGthFileSystemToolkit {
    constructor() {}

    getTools() {
      return [
        { name: 'read_file', gthFileSystemType: 'read' },
        { name: 'write_file', gthFileSystemType: 'write' },
        { name: 'list_directory', gthFileSystemType: 'read' },
        { name: 'edit_file', gthFileSystemType: 'write' },
      ];
    }

    getFilteredTools(operations: ('read' | 'write')[]) {
      return this.getTools().filter((tool: any) => operations.includes(tool.gthFileSystemType));
    }
  },
}));

vi.mock('#src/utils/systemUtils.js', () => ({
  getCurrentWorkDir: () => '/test/dir',
  getUseColour: () => false,
}));

// Mock the GthDevToolkit so dev-tool enablement is observable via a single marker tool.
vi.mock('#src/tools/GthDevToolkit.js', () => ({
  default: class MockGthDevToolkit {
    devConfig: unknown;
    constructor(devConfig: unknown) {
      this.devConfig = devConfig;
    }
    getTools() {
      return [{ name: 'run_shell_command', gthDevToolConfig: this.devConfig }];
    }
  },
}));

describe('Config Tool Functions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getDefaultTools', () => {
    it('should return all tools when filesystem is "all"', async () => {
      const result = await getDefaultTools({
        filesystem: 'all',
      } as Partial<GthConfig> as GthConfig);

      expect(result).toHaveLength(4);
      expect(result.map((t) => t.name)).toEqual([
        'read_file',
        'write_file',
        'list_directory',
        'edit_file',
      ]);
    });

    it('should return no tools when filesystem is "none"', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
      } as Partial<GthConfig> as GthConfig);

      expect(result).toEqual([]);
    });

    it('should return only read tools when filesystem is "read"', async () => {
      const result = await getDefaultTools({
        filesystem: 'read',
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toEqual(['read_file', 'list_directory']);
    });

    it('should work with read in array format', async () => {
      const result = await getDefaultTools({
        filesystem: ['read'],
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toEqual(['read_file', 'list_directory']);
    });

    it('should filter filesystem tools based on specific read-only tool names', async () => {
      const result = await getDefaultTools({
        filesystem: ['read_file'],
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toEqual(['read_file']);
    });

    it('should include built-in tools when specified', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: ['gth_status_update'],
      } as Partial<GthConfig> as GthConfig);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('gth_status_update');
    });

    it('should combine filesystem and built-in tools', async () => {
      const result = await getDefaultTools({
        filesystem: 'read',
        builtInTools: ['gth_status_update'],
      } as Partial<GthConfig> as GthConfig);
      expect(result).toHaveLength(3);
      expect(result.map((t) => t.name)).toEqual([
        'read_file',
        'list_directory',
        'gth_status_update',
      ]);
    });

    // Regression: show_a2ui_surface used to live in a second registry (resolvers.ts step 4),
    // so getBuiltInTools emitted a spurious "Unknown built-in tool" warning for it before
    // the tool was loaded elsewhere. It now resolves from the single AVAILABLE_BUILT_IN_TOOLS.
    it('should load show_a2ui_surface from the unified registry without warning', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: ['show_a2ui_surface'],
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toEqual(['show_a2ui_surface']);
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    // CFG-52 — gth_gh_read_file is a legitimate registry entry but is built by the review module
    // (it binds to the PR under review), so this loader must SKIP it rather than warn. Asserted on
    // `code`, a command that never loads the tool at all: that is where a stray "Unknown built-in
    // tool" would surface for a user who only ever meant to configure their PR reviews.
    //
    // In the loader the skip runs FIRST — ahead of the enablement check and of the
    // AVAILABLE_BUILT_IN_TOOLS lookup — so in shipped code this entry is intercepted by name and
    // never reaches either, whichever form it is written in. The entry is nonetheless written in
    // an ENABLED form on purpose, because what this case can be evidence about is what happens
    // WITHOUT the skip: `true` then clears the enablement check, reaches the lookup, finds this
    // name deliberately absent, and warns — the case goes red. A `false` entry would instead be
    // dropped by the enablement check before the lookup and stay green, so the disabled form
    // cannot discriminate here.
    it('should skip gth_gh_read_file without warning, on a command that never loads it', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: { gth_gh_read_file: true, gth_status_update: true },
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toEqual(['gth_status_update']);
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    // What intercepts this entry is the SKIP, which runs first and matches on the name alone — the
    // enablement check is never reached for this tool. The case is still not evidence about the
    // skip: with the skip removed the enablement check catches the disabled entry instead, and it
    // stays green either way. It earns its place as the plain guarantee that a registry entry
    // written as `false` loads nothing and says nothing.
    it('does not load a DISABLED gth_gh_read_file entry, and does not warn about it', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: { gth_gh_read_file: false, gth_status_update: true },
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toEqual(['gth_status_update']);
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    it('should skip a CONFIGURED gth_gh_read_file entry without warning or loading it', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: { gth_gh_read_file: { maxBytes: 200000 } },
      } as Partial<GthConfig> as GthConfig);
      // Enabled in the registry, but still not emitted here — the review module builds it.
      expect(result).toEqual([]);
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });

    it('should still warn only for genuinely unknown built-in tools', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: ['does_not_exist'],
      } as Partial<GthConfig> as GthConfig);
      expect(result).toEqual([]);
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        'Unknown built-in tool: does_not_exist'
      );
    });

    // EXT-84 — the prompt notes must never name a filesystem tool this filter did not register, so
    // both read the answer from ONE derivation in core. This pins that derivation against the
    // OBSERVABLE toolset: for every shape of the `filesystem` union, "is write_file among the
    // registered tools?" must equal what isFilesystemToolRegistered says. If the filter and the
    // predicate ever drift, the prompt starts naming an absent tool — the defect this closes.
    it('the shared registration predicate agrees with the tools actually registered', async () => {
      const CASES: (FilesystemToolsConfig | undefined)[] = [
        'all',
        'read',
        'none',
        ['all'],
        ['read'],
        ['read_file'],
        ['write_file'],
        ['read', 'write_file'],
        ['src'],
        [],
        undefined,
      ];
      for (const filesystem of CASES) {
        const result = await getDefaultTools({ filesystem } as Partial<GthConfig> as GthConfig);
        const registered = result.some((t) => t.name === WRITE_FILE_TOOL_NAME);
        expect({
          filesystem,
          registered,
        }).toEqual({
          filesystem,
          registered: isFilesystemToolRegistered(filesystem, WRITE_FILE_TOOL_NAME, 'write'),
        });
      }
    });

    // CFG-18 (assembly-level, beyond the resolver): the object form force-disables a default-on
    // built-in tool and enables a default-off one — asserted through the real getBuiltInTools
    // assembly (dynamic import), not just the resolver.
    it('object form force-disables a default-on built-in tool and enables a default-off one', async () => {
      // Baseline: the default-on gth_checklist is loaded when present.
      const withChecklist = await getDefaultTools({
        filesystem: 'none',
        builtInTools: { gth_checklist: true },
      } as Partial<GthConfig> as GthConfig);
      expect(withChecklist.map((t) => t.name)).toContain('gth_checklist');

      // Force-disable gth_checklist (bare false) AND enable a default-off tool (gth_status_update).
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: { gth_checklist: false, gth_status_update: true },
      } as Partial<GthConfig> as GthConfig);
      const names = result.map((t) => t.name);
      expect(names).not.toContain('gth_checklist'); // force-disabled
      expect(names).toContain('gth_status_update'); // enabled via the object form
    });

    // GS2-51: gth_grep enablement rides on the existing CFG-18 builtInTools system. The shipped
    // default (DEFAULT_CONFIG.builtInTools) turns it ON for the lean agent; the object form's
    // `enabled: false` removes it. No parallel enablement mechanism.
    it('gth_grep is ON under the shipped default builtInTools (enabled for the lean agent)', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: DEFAULT_CONFIG.builtInTools,
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).toContain('gth_grep');
    });

    it('builtInTools { gth_grep: { enabled: false } } removes gth_grep from the tool set', async () => {
      const result = await getDefaultTools({
        filesystem: 'none',
        builtInTools: { gth_grep: { enabled: false } },
      } as Partial<GthConfig> as GthConfig);
      expect(result.map((t) => t.name)).not.toContain('gth_grep');
    });

    it('enables dev tools for the exec command from commands.exec.devTools', async () => {
      const result = await getDefaultTools(
        {
          filesystem: 'none',
          commands: { exec: { builtInTools: { run_shell_command: true } } },
        } as Partial<GthConfig> as GthConfig,
        'exec'
      );
      expect(result.map((t) => t.name)).toContain('run_shell_command');
    });

    it('does NOT enable dev tools for plain ask (no --write)', async () => {
      const result = await getDefaultTools(
        {
          filesystem: 'read',
          commands: { ask: { builtInTools: { run_shell_command: true } } },
        } as Partial<GthConfig> as GthConfig,
        'ask'
      );
      expect(result.map((t) => t.name)).not.toContain('run_shell_command');
    });

    it('enables dev tools for ask when askWriteMode is set (ask --write)', async () => {
      const result = await getDefaultTools(
        {
          filesystem: 'all',
          askWriteMode: true,
          commands: { ask: { builtInTools: { run_shell_command: true } } },
        } as Partial<GthConfig> as GthConfig,
        'ask'
      );
      expect(result.map((t) => t.name)).toContain('run_shell_command');
    });

    // B5: lean-keeps-tools. The backend is selected independently of the tool resolver, so a lean
    // code-mode run resolves the SAME default toolset as deep: gaunt-sloth's own filesystem toolkit
    // (GthFileSystemToolkit) plus, in code mode, the hardened GthDevToolkit shell. Lean is not
    // capability-stripped — it only lacks the extras a heavier runtime added (subagent task, todos,
    // summarization, /large_tool_results). This asserts the resolver, which lean and deep share.
    it('code-mode default tools include the fs toolkit AND the dev/shell tool (lean is not toothless)', async () => {
      const result = await getDefaultTools(
        {
          filesystem: 'all',
        } as Partial<GthConfig> as GthConfig,
        'code'
      );
      const names = result.map((t) => t.name);
      // GthFileSystemToolkit tools
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('edit_file');
      // GthDevToolkit shell tool (code mode constructs the toolkit even without devTools config)
      expect(names).toContain('run_shell_command');
    });
  });
});
