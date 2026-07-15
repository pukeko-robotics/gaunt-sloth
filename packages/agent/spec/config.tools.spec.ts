import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultTools } from '#src/builtInToolsConfig.js';
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
    // capability-stripped — it only drops the deepagents-specific extras (subagent task, todos,
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
