/**
 * @packageDocumentation
 * The single interpretation of the `filesystem` config value: **which filesystem tools it
 * registers**.
 *
 * `filesystem` is a union — `'all'`, `'read'`, `'none'`, or a `string[]` of tool names — so any
 * two-value check ("is it `read` or `none`?") is wrong by construction. The toolkit filter in
 * `@gaunt-sloth/agent` (`filterFilesystemTools`) and the system-prompt notes in this package both
 * need the answer, and they must never derive it separately: a prompt that names a tool the filter
 * did not register tells the model to call something that does not exist. {@link
 * isFilesystemToolRegistered} is that one derivation; both call it.
 */

import { BUILT_IN_TOOL_ACCESS, type BuiltInToolAccess } from '#src/config/tool-descriptions.js';

/** The `filesystem` config union: an allow-list of tool names, or one of the three modes. */
export type FilesystemToolsConfig = string[] | 'all' | 'read' | 'none';

/**
 * The filesystem tool that creates a file from supplied content.
 *
 * Exported as a constant because prompt text names it literally: the note telling the model how to
 * write a commit message interpolates this, so the name the model is told and the name the
 * registration check asks about cannot drift apart.
 */
export const WRITE_FILE_TOOL_NAME = 'write_file';

/**
 * Whether a filesystem tool is registered under the given `filesystem` config.
 *
 * `access` is the tool's own read/write class — the runtime `gthFileSystemType` the toolkit stamps
 * on each tool, or {@link BUILT_IN_TOOL_ACCESS} for a caller that has only a name. A tool with no
 * class is never covered by `'read'`; it can still be named explicitly in the array form.
 *
 * The array form is an allow-list of tool NAMES which may also carry the `'read'` and `'all'`
 * keywords, so `['read', 'write_file']` means "every read tool, plus write_file". A value that is
 * neither a known mode nor an array leaves the toolset unrestricted, matching the filter's own
 * fallback, so an absent or malformed value never silently strips the model's tools.
 */
export function isFilesystemToolRegistered(
  filesystemConfig: FilesystemToolsConfig | undefined,
  toolName: string | undefined,
  access: BuiltInToolAccess | undefined
): boolean {
  if (filesystemConfig === 'none') return false;
  if (filesystemConfig === 'all') return true;
  if (filesystemConfig === 'read') return access === 'read';
  if (!Array.isArray(filesystemConfig)) return true;
  if (filesystemConfig.includes('all')) return true;
  if (filesystemConfig.includes('read') && access === 'read') return true;
  return filesystemConfig.some(
    (name) => name !== 'read' && name !== 'all' && name === toolName && !!toolName
  );
}

/**
 * Whether {@link WRITE_FILE_TOOL_NAME} is registered under the given `filesystem` config — the
 * question the commit-message guidance asks before it names the tool.
 */
export function isWriteFileToolRegistered(
  filesystemConfig: FilesystemToolsConfig | undefined
): boolean {
  return isFilesystemToolRegistered(
    filesystemConfig,
    WRITE_FILE_TOOL_NAME,
    BUILT_IN_TOOL_ACCESS[WRITE_FILE_TOOL_NAME]
  );
}
