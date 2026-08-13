/**
 * @packageDocumentation
 * Resolves the working directory the shell tool (`run_shell_command`) spawns in, keeping it aligned
 * with the filesystem tools' root so the shell and the fs tools share ONE path namespace (EXT-22
 * S4 / EXT-23). A shell that spawns somewhere the fs tools do not read is how a model writes a file
 * it then cannot find.
 *
 * It resolves to `getCurrentWorkDir()`, and it exists as a named seam rather than as a direct call
 * at each spawn site so that every subprocess the agent starts — `run_shell_command`
 * ({@link file://../GthDevToolkit.ts}) and custom tools ({@link file://../GthCustomToolkit.ts},
 * EXT-42) — resolves it the same way. A transport that re-roots the filesystem per session changes
 * this one function; two spawn sites reading the cwd directly would have to be found first.
 */
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';

/** Working directory the shell tool and custom-tool subprocesses spawn in. */
export function getShellWorkDir(): string {
  return getCurrentWorkDir();
}
