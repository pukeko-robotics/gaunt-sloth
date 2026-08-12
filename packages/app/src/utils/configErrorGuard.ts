import {
  isConfigDiscoveryError,
  isMissingProviderKeyError,
  type ConfigDiscoveryError,
  type MissingProviderKeyError,
} from '@gaunt-sloth/core/config.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { exit, type ProgramLike } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * @packageDocumentation
 * The `gth` CLI's deliberate termination point for a config load that could not produce a usable
 * configuration — no resolvable API key ({@link MissingProviderKeyError}), or a named identity
 * profile that does not exist / a malformed config layer ({@link ConfigDiscoveryError}).
 *
 * The config loader raises these rather than exiting, so `gth eval`, the AG-UI/ACP servers and
 * embedding consumers can classify the failure — `gth eval` in particular needs a config failure to
 * be a HARNESS error (exit 2), distinct from a product regression (exit 1). The plain CLI verbs have
 * no such need — for a person at a terminal the run is over — so SOMEONE has to choose the exit
 * code, and this is where: one place, at the top, in the `gth` entry point rather than scattered
 * through fourteen command actions. Printing the message here is what keeps the user-facing output
 * identical to when the loader printed it itself.
 *
 * Only those error classes are handled. Everything else propagates exactly as before, so the
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
 * Print an unusable-configuration failure the way the loader used to and end the run with exit
 * code 1 — a named identity profile that does not resolve, or a malformed config layer.
 *
 * The message is the one the loader built, so what the user sees is unchanged from when the
 * loader printed it and exited itself.
 *
 * @returns true when `error` was a config-discovery failure (and the process is therefore exiting).
 */
export function handleConfigDiscoveryError(error: unknown): error is ConfigDiscoveryError {
  if (!isConfigDiscoveryError(error)) {
    return false;
  }
  displayError(error.message);
  exit(1);
  return true;
}

/**
 * Wrap a commander program so an unusable configuration terminates the CLI cleanly.
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
        if (handleMissingProviderKey(error) || handleConfigDiscoveryError(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
