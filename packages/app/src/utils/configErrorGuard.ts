import {
  isMissingProviderKeyError,
  type MissingProviderKeyError,
} from '@gaunt-sloth/core/config.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { exit, type ProgramLike } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * @packageDocumentation
 * The `gth` CLI's deliberate termination point for a config load that found no API key.
 *
 * The config loader raises {@link MissingProviderKeyError} rather than exiting, so `gth eval`, the
 * AG-UI/ACP servers and embedding consumers can classify the failure. The plain CLI verbs have no
 * such need — for a person at a terminal the run is over — so SOMEONE has to choose the exit code,
 * and this is where: one place, at the top, in the `gth` entry point rather than scattered through
 * fourteen command actions.
 *
 * Only that one error class is handled. Everything else propagates exactly as before, so the
 * GS2-48 crash handler still sees genuine crashes and still writes their snapshot.
 */

/**
 * Print a missing-provider-key failure the way the loader used to and end the run with exit code 1.
 *
 * @returns true when `error` was a missing-key failure (and the process is therefore exiting).
 */
export function handleMissingProviderKey(error: unknown): error is MissingProviderKeyError {
  if (!isMissingProviderKeyError(error)) {
    return false;
  }
  displayError(error.message);
  exit(1);
  return true;
}

/**
 * Wrap a commander program so a missing provider key terminates the CLI cleanly.
 *
 * Presented as a {@link ProgramLike} because that is the seam `readStdin` already parses through:
 * argument parsing is where every command action runs, so wrapping it catches the failure wherever
 * in the CLI it was raised, without each command growing its own try/catch. Any other rejection is
 * re-thrown unchanged, leaving it in exactly the position it occupied before.
 */
export function guardProgramConfigErrors(program: ProgramLike): ProgramLike {
  return {
    getOptionValue: (key: string) => program.getOptionValue(key),
    parseAsync: async (args?: string[]) => {
      try {
        return await program.parseAsync(args);
      } catch (error) {
        if (handleMissingProviderKey(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
