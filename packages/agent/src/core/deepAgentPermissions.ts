import type { FilesystemPermission } from 'deepagents';

export type { FilesystemPermission };

/**
 * Tool names deepagents' filesystem middleware registers. This mirrors deepagents'
 * internal `FILESYSTEM_TOOL_NAMES` (which is declared in its types but not exported
 * at runtime). `createDeepAgent` throws on a name collision with any of these, so a
 * gsloth-supplied tool sharing one of these names is superseded by the deep agent's
 * built-in filesystem tool. Kept here as the single place the deep path references it.
 */
export const FILESYSTEM_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
] as const;

/** The slice of GthConfig the permission mapping consumes. */
export interface PermissionConfigSlice {
  filesystem: string[] | 'all' | 'read' | 'none';
  aiignore?: { enabled?: boolean; patterns?: string[] };
}

/**
 * Convert `.aiignore` patterns (relative, .gitignore-ish) into deepagents deny rules.
 *
 * deepagents matches the path argument the model passes to a fs tool — resolved by the
 * backend — against ABSOLUTE globs. With `virtualMode` the backend treats paths as
 * virtual-absolute under `rootDir`, so we anchor at "/".
 *
 * A bare pattern (`*.env`, `secret.txt`) should match at any depth, so we emit both a
 * top-level (`/secret.txt`) and a recursive (`/&#42;&#42;/secret.txt`) rule. A pattern already
 * containing "/" (`config/secrets.json`) is anchored as-is (plus a `/**` subtree rule).
 */
export function aiignoreToPermissions(patterns: string[]): FilesystemPermission[] {
  const rules: FilesystemPermission[] = [];
  for (const raw of patterns) {
    const clean = raw.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (clean.length === 0) continue;
    const paths = clean.includes('/')
      ? [`/${clean}`, `/${clean}/**`]
      : [`/${clean}`, `/**/${clean}`];
    rules.push({ operations: ['read', 'write'], paths, mode: 'deny' });
  }
  return rules;
}

/** Map gsloth's filesystem mode onto deepagents permission rules. */
export function filesystemModeToPermissions(
  fs: string[] | 'all' | 'read' | 'none'
): FilesystemPermission[] {
  if (fs === 'all') return [];
  if (fs === 'read') return [{ operations: ['write'], paths: ['/**'], mode: 'deny' }];
  if (fs === 'none') return [{ operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }];
  // string[] — explicit allow-list of directories. Allow read+write within each,
  // deny everything else. Allow rules first (first-match-wins), deny catch-all last.
  const allow: FilesystemPermission[] = fs
    .filter((d) => d !== 'all' && d !== 'read')
    .map((d) => {
      const dir = `/${d.replace(/^\.?\//, '').replace(/\/+$/, '')}`;
      return { operations: ['read', 'write'], paths: [`${dir}/**`, dir], mode: 'allow' };
    });
  return [...allow, { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }];
}

/**
 * Compose the full permission list. `.aiignore` deny rules go FIRST so they win over
 * any allow rule (first-match-wins). Then the filesystem-mode rules. `.aiignore` is
 * skipped when explicitly disabled (`aiignore.enabled === false`) or has no patterns.
 */
export function buildPermissions(config: PermissionConfigSlice): FilesystemPermission[] {
  const aiignore =
    config.aiignore?.enabled !== false && config.aiignore?.patterns?.length
      ? aiignoreToPermissions(config.aiignore.patterns)
      : [];
  return [...aiignore, ...filesystemModeToPermissions(config.filesystem)];
}
