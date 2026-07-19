/**
 * @packageDocumentation
 * Built-in tools config. {@link AVAILABLE_BUILT_IN_TOOLS} has a list of available tools.
 */
import GthFileSystemToolkit from '#src/tools/GthFileSystemToolkit.js';
import { StructuredToolInterface } from '@langchain/core/tools';
import {
  GthDevToolsConfig,
  GthConfig,
  CustomToolsConfig,
  getEffectiveDevToolsConfig,
  normalizeBuiltInTools,
  isBuiltInToolEntryEnabled,
  DEV_TOOL_NAMES,
} from '@gaunt-sloth/core/config.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { GthCommand } from '@gaunt-sloth/core/core/types.js';
import GthDevToolkit from '#src/tools/GthDevToolkit.js';
import GthCustomToolkit from '#src/tools/GthCustomToolkit.js';

/**
 * Available built-in tools may be configured in JSON config, see `builtInTools` of {@link GthConfig}.
 *
 * Does not include `filesystem`, because filesystem has its own config in {@link GthConfig}.
 */
export const AVAILABLE_BUILT_IN_TOOLS = {
  /**
   * Reference tool. Simply prints provided argument to the screen.
   */
  gth_status_update: '#src/tools/gthStatusUpdateTool.js',
  /**
   * Web fetch tool.
   */
  gth_web_fetch: '#src/tools/gthWebFetchTool.js',
  /**
   * AG-UI A2UI surface tool: lets the agent render an A2UI surface in the web client.
   */
  show_a2ui_surface: '#src/tools/showA2UISurfaceTool.js',
  /**
   * Checklist / todo planning tool for the lean agent (the `write_todos` equivalent). Enabled
   * by default (see {@link DEFAULT_CONFIG}); disable by setting your own `builtInTools`.
   */
  gth_checklist: '#src/tools/gthChecklistTool.js',
  /**
   * Content-search (grep) tool: ripgrep-backed regex search over file CONTENTS, with an
   * in-process JS fallback when `rg` is absent. Permission-light (no shell approval) and
   * available in every mode. Named `gth_grep` to avoid colliding with the deep backend's
   * built-in `grep`. Enabled by default (see {@link DEFAULT_CONFIG.builtInTools}, GS2-51); disable
   * with `{ "builtInTools": { "gth_grep": { "enabled": false } } }`. Its searched corpus is
   * selectable via the `fileSet` tool-config key (`gitignore` default / `all`).
   */
  gth_grep: '#src/tools/gthGrepTool.js',
} as const;

/**
 * Get default tools based on filesystem and built-in tools configuration
 */
export async function getDefaultTools(
  config: GthConfig,
  command?: GthCommand
): Promise<StructuredToolInterface[]> {
  const filesystemTools = filterFilesystemTools(
    config.filesystem,
    config.aiignore,
    config.binaryFormats
  );
  const builtInTools = await getBuiltInTools(config);
  // Dev tools (run commands etc.) are available to the interactive `code` command and to the
  // scripted `exec` command — both are "do-the-job" runs. `ask --write` (config.askWriteMode) opts
  // `ask` into the same do-the-job tools. CFG-18: the dev/shell config is resolved from the unified
  // `builtInTools` registry by the shared core resolver (was per-command `devTools`).
  const askWrite = command === 'ask' && config.askWriteMode === true;
  const devToolConfig = getEffectiveDevToolsConfig(config, command);
  const devTools = await filterDevTools(askWrite ? 'code' : command, devToolConfig);
  const customTools = getCustomTools(config, command);
  return [...filesystemTools, ...devTools, ...customTools, ...builtInTools];
}

async function filterDevTools(
  command: GthCommand | undefined,
  devToolConfig: GthDevToolsConfig | undefined
): Promise<StructuredToolInterface[]> {
  // Dev tools only apply to the do-the-job commands (`code` / `exec`; `ask --write` is mapped
  // to `code` by the caller). EXT-12: for `code` the toolkit is constructed even when no
  // devTools config is present, so the shell tool's absent-config default (ON in `code`) can
  // emit `run_shell_command` (still gated). For `exec` we keep the prior behaviour — no config
  // means no dev tools — by short-circuiting when the config is absent.
  if (command !== 'code' && command !== 'exec') {
    return [];
  }
  if (command === 'exec' && !devToolConfig) {
    return [];
  }
  // Pass the command so GthDevToolkit resolves the shell default for the active mode.
  const toolkit = new GthDevToolkit(devToolConfig ?? {}, command);
  return [...toolkit.getTools()];
}

/**
 * Get custom tools based on configuration.
 * Supports global customTools and per-command overrides.
 */
function getCustomTools(config: GthConfig, command?: GthCommand): StructuredToolInterface[] {
  // Determine which custom tools to use
  let toolsConfig: CustomToolsConfig | false | undefined;

  if (command && config.commands?.[command]) {
    const cmdConfig = config.commands[command];
    // Check if command has customTools override
    if ('customTools' in cmdConfig) {
      toolsConfig = cmdConfig.customTools;
    } else {
      // No override, use root-level
      toolsConfig = config.customTools;
    }
  } else {
    // No command specified or no command config, use root-level
    toolsConfig = config.customTools;
  }

  // If explicitly disabled or empty, return no tools
  if (toolsConfig === false || !toolsConfig || Object.keys(toolsConfig).length === 0) {
    return [];
  }

  // Create toolkit with the determined config
  const toolkit = new GthCustomToolkit(toolsConfig);
  return toolkit.getTools();
}

/**
 * Filter filesystem tools based on configuration
 */

function filterFilesystemTools(
  filesystemConfig: string[] | 'all' | 'read' | 'none',
  aiignoreConfig?: {
    enabled?: boolean;
    patterns?: string[];
  },
  binaryFormats?: GthConfig['binaryFormats']
): StructuredToolInterface[] {
  const toolkit = new GthFileSystemToolkit({
    allowedDirectories: [getCurrentWorkDir()],
    aiignoreConfig,
    binaryFormats,
  });
  if (filesystemConfig === 'all') {
    return toolkit.getTools();
  }

  if (filesystemConfig === 'none') {
    return [];
  }

  if (filesystemConfig === 'read') {
    // Read-only: only allow read operations
    return toolkit.getFilteredTools(['read']);
  }

  if (!Array.isArray(filesystemConfig)) {
    return toolkit.getTools();
  }

  if (filesystemConfig.includes('all')) {
    return toolkit.getTools();
  }

  // Handle an array of specific tool names or 'read'/'all'
  const allowedTools: StructuredToolInterface[] = filesystemConfig.includes('read')
    ? toolkit.getFilteredTools(['read'])
    : [];

  // Also allow specific tool names
  const allowedToolNames = new Set(
    filesystemConfig.filter((name) => name !== 'read' && name !== 'all')
  );
  const specificNamedTools = toolkit.getTools().filter((tool) => {
    return tool.name && allowedToolNames.has(tool.name);
  });

  // Combine and deduplicate
  const allAllowedTools = [...allowedTools, ...specificNamedTools];
  return allAllowedTools.filter(
    (tool, index, arr) => arr.findIndex((t) => t.name === tool.name) === index
  );
}

/**
 * Get built-in tools based on configuration
 */
async function getBuiltInTools(config: GthConfig): Promise<StructuredToolInterface[]> {
  const tools: StructuredToolInterface[] = [];

  // CFG-18: `builtInTools` may be a string[] or the widened registry — normalize to a name→value
  // lookup. Dev/shell tools (run_*, run_shell_command) are emitted by GthDevToolkit via the dev
  // bucket, so skip them here (a registry entry for them is legitimate, not an unknown built-in).
  const registry = normalizeBuiltInTools(config.builtInTools);

  for (const [toolName, value] of Object.entries(registry)) {
    if (DEV_TOOL_NAMES.includes(toolName)) {
      continue;
    }
    if (!isBuiltInToolEntryEnabled(value)) {
      continue;
    }
    if (toolName in AVAILABLE_BUILT_IN_TOOLS) {
      try {
        const tool = await import(
          AVAILABLE_BUILT_IN_TOOLS[toolName as keyof typeof AVAILABLE_BUILT_IN_TOOLS]
        );
        tools.push(tool.get(config));
      } catch (error) {
        displayWarning(`Failed to load built-in tool '${toolName}': ${error}`);
      }
    } else {
      displayWarning(`Unknown built-in tool: ${toolName}`);
    }
  }

  return tools;
}
