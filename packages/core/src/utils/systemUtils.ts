import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { emitKeypressEvents } from 'node:readline';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline/promises';
import { displayInfo, displayWarning } from './consoleUtils.js';
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';

/**
 * Generic interface for program-like objects that can parse arguments.
 * Allows decoupling from commander's Command type.
 */
export interface ProgramLike {
  getOptionValue(key: string): unknown;
  parseAsync(args?: string[]): Promise<unknown>;
}

/**
 * This file contains all system functions and objects that are globally available
 * but not imported directly, such as process.stdin, process.stdout, process.argv,
 * process.env, process.cwd(), process.exit(), etc.
 *
 * By centralizing these in one file, we improve testability and make it easier
 * to mock these dependencies in tests.
 */

interface InnerState {
  installDir: string | null | undefined;
  projectDir: string | undefined;
  stringFromStdin: string;
  useColour: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitForEscapeCallback?: (_: any, key: any) => void;
  interruptRequested: boolean;
  logWriteStream?: WriteStream;
}

const innerState: InnerState = {
  installDir: undefined,
  projectDir: undefined,
  stringFromStdin: '',
  useColour: false,
  waitForEscapeCallback: undefined,
  interruptRequested: false,
  logWriteStream: undefined,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const keypressHandler = (callback: () => void) => (chunk: any, key: any) => {
  const isCtrlC = (key?.ctrl && key?.name === 'c') || chunk === '\u0003';
  // Once an interrupt has been requested (Escape/Q/Ctrl+C), a Ctrl+C escalates to a
  // hard exit. Raw mode swallows SIGINT, so if the first interrupt wedges (e.g. a stuck
  // tool call) this is the user's only way out. 130 = 128 + SIGINT, the conventional code.
  if (isCtrlC && innerState.interruptRequested) {
    displayWarning('\nForce exiting...');
    // Leave the terminal usable: drop raw mode before exiting so a wedged tool call can't
    // strand the user's shell with echo/line-editing disabled. Node restores TTY state on a
    // normal exit, but being explicit here is cheap insurance on the hard-exit path.
    process.stdin.setRawMode?.(false);
    process.exit(130);
  }
  if (key?.name === 'escape' || key?.name === 'q' || isCtrlC) {
    displayWarning('\nInterrupting...');
    innerState.interruptRequested = true;
    callback();
    return;
  }
};

export const waitForEscape = (callback: () => void, enabled: boolean) => {
  if (!enabled) {
    return;
  }
  innerState.interruptRequested = false;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  // Resume stdin so keypress events fire, and explicitly ref the handle to keep the event loop
  // alive during the wait. resume() refs in most Node versions, but a prior stopWaitingForEscape
  // unref()'d the handle and resume() does not reliably re-ref it everywhere - so ref() is needed
  // for symmetry, otherwise the process could exit mid-wait if stdin were the only live handle.
  process.stdin.resume?.();
  process.stdin.ref?.();
  innerState.waitForEscapeCallback = keypressHandler(callback);
  process.stdin.on('keypress', innerState.waitForEscapeCallback);
  displayInfo(`
  ┌--------------------------------------┐
  │ Press Escape or Q to interrupt Agent │
  └--------------------------------------┘
  `);
};

export const stopWaitingForEscape = () => {
  if (innerState.waitForEscapeCallback) {
    process.stdin.setRawMode(false);
    process.stdin.off('keypress', innerState.waitForEscapeCallback);
    innerState.waitForEscapeCallback = undefined;
    // Unref stdin so it no longer keeps the event loop alive (waitForEscape resumed
    // it, which refs the handle). On a TTY stdin.isPaused() is false, so we must not
    // rely on re-pausing only "previously paused" streams - that left one-shot
    // commands (e.g. `gth pr` with no arguments) hanging after completion. unref leaves the
    // read state untouched; interactive sessions (chat/code) re-ref via setRawMode(true)
    // before the next rl.question(), so they keep prompting after each agent response.
    process.stdin.unref?.();
  }
};

export const setRawMode = (rawMode: boolean) => {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(rawMode);
    if (rawMode) {
      // Re-ref stdin when (re)entering raw mode for interactive input.
      // stopWaitingForEscape() unref's stdin after each agent run so one-shot commands
      // can exit; without re-reffing here the chat/code loop's next rl.question() would
      // not keep the event loop alive and the process would exit after the first
      // response (v1.5.5 regression).
      process.stdin.ref?.();
    }
  }
};

/**
 * Ref stdin so it keeps the event loop alive, WITHOUT changing raw mode.
 *
 * EXT-18: the ref/unref of stdin used to be coupled to raw mode (only setRawMode(true)
 * re-ref'd, see above), but some interactive prompts run in COOKED mode after a stream
 * end. When an agent run suspends on a tool-approval interrupt, the stream's finally
 * calls stopWaitingForEscape(), which unref's stdin. The readline approval prompt then
 * does setRawMode(false) (cooked, so typed input echoes) and awaits rl.question(...) -
 * but with stdin unref'd and nothing else holding the loop open the process exits to the
 * shell before the user can answer. Refing stdin (decoupled from raw mode) before such a
 * prompt keeps the loop alive so rl.question() can wait for input. This is intentionally
 * NOT folded into setRawMode(false): the cooked-path unref is load-bearing for one-shot
 * commands (e.g. `gth pr`) to exit, so only the interactive-prompt sites opt back in.
 */
export const refStdin = (): void => {
  if (process.stdin.isTTY) {
    process.stdin.ref?.();
  }
};

export const initLogStream = (logFileName: string): void => {
  try {
    // Close existing stream if present
    if (innerState.logWriteStream) {
      innerState.logWriteStream.end();
    }

    // Create new write stream with append mode
    innerState.logWriteStream = createWriteStream(logFileName, {
      flags: 'a',
      autoClose: true,
    });

    // Handle stream errors
    innerState.logWriteStream.on('error', (err) => {
      displayWarning(`Log stream error: ${err.message}`);
      innerState.logWriteStream = undefined;
    });

    // Handle stream close
    innerState.logWriteStream.on('close', () => {
      innerState.logWriteStream = undefined;
    });
  } catch (err) {
    displayWarning(
      `Failed to create log stream: ${err instanceof Error ? err.message : String(err)}`
    );
    innerState.logWriteStream = undefined;
  }
};

export const writeToLogStream = (message: string): void => {
  if (innerState.logWriteStream && !innerState.logWriteStream.destroyed) {
    innerState.logWriteStream.write(message);
  }
};

export const closeLogStream = (): void => {
  if (innerState.logWriteStream && !innerState.logWriteStream.destroyed) {
    innerState.logWriteStream.end();
    innerState.logWriteStream = undefined;
  }
};

// Ensure log stream is closed on process exit
process.on('exit', () => {
  closeLogStream();
});

process.on('SIGINT', () => {
  closeLogStream();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeLogStream();
  process.exit(0);
});

// Process-related functions and objects

/**
 * The process.cwd() has a weird behaviour when the app is a part of monorepo,
 * always returning the directory of this specific project,
 * this causes integration tests to fail, because they are specifically testing ability to respect actual current dirs.
 * Gaunt Sloth is a command line tool and it is always supposed to function in the current directory.
 * Using INIT_CWD forces to always use actual CWD. cwd() fallback is just in case.
 * In environments where INIT_CWD is available (npm and alike) - INIT_CWD is the correct choice,
 * since they are likely to juggle the process.cwd(), where it is unavailable process.cwd() is used.
 */
export const getCurrentWorkDir = (): string => process.env?.INIT_CWD ?? process.cwd();
/**
 * The raw process working directory, ignoring `INIT_CWD`. {@link getCurrentWorkDir} prefers
 * npm's `INIT_CWD` (correct for a CLI invoked via an npm bin), but that leaks into long-lived
 * subprocesses (e.g. an ACP agent spawned by an IDE), so server entry points that get their
 * real workspace from the protocol should use this instead.
 */
export const getProcessCwd = (): string => process.cwd();
/**
 * The directory of the DISCOVERED project config (the up-tree match, or the `--config`
 * override). It governs ONLY post-config, project-relative artifact resolution (project
 * guidelines, prompts, `.gsloth-settings`, outputs). When unset (a global-only config, no
 * config at all, or before discovery has run) callers fall back to cwd via {@link getProjectDir}.
 *
 * This is NOT the global-config dir (`~/.gsloth`): the global config stays cwd-anchored by
 * design, so it must never be routed through this value.
 */
export const setProjectDir = (dir: string | undefined): void => {
  innerState.projectDir = dir ? resolve(dir) : undefined;
};
/**
 * The discovered project root for project-relative artifact resolution, falling back to
 * {@link getCurrentWorkDir} when no project config has been discovered (see {@link setProjectDir}).
 * Config DISCOVERY and DETECTION must NOT use this; they stay cwd-bound.
 */
export const getProjectDir = (): string => innerState.projectDir ?? getCurrentWorkDir();
export const getInstallDir = (): string => {
  if (innerState.installDir) {
    return innerState.installDir;
  }
  throw new Error('Install directory not set');
};
/**
 * Cached string from stdin. Should only be called after readStdin completes execution.
 */
export const getStringFromStdin = (): string => {
  return innerState.stringFromStdin;
};
/**
 * Get the current useColour setting.
 */
export const getUseColour = (): boolean => {
  return innerState.useColour;
};
/**
 * Set the useColour setting.
 */
export const setUseColour = (useColour: boolean): void => {
  innerState.useColour = useColour;
};

export const isTTY = (): boolean => !!stdin.isTTY;

export const exit = (code?: number): never => process.exit(code || 0);
export const stdin = process.stdin;
export const stdout = process.stdout;
export const stderr = process.stderr;
export const argv = process.argv;
export const env = process.env;
export const setExitCode = (code: number): void => {
  process.exitCode = code;
};
export { createInterface };
export type { ReadLineInterface };

// noinspection JSUnusedGlobalSymbols
/**
 * Provide the path to the entry point of the application.
 * This is used to set the install directory.
 * This is called from cli.js root entry point.
 */
export const setEntryPoint = (indexJs: string): void => {
  const filePath = fileURLToPath(indexJs);
  const dirPath = dirname(filePath);
  innerState.installDir = resolve(dirPath);
};

/**
 * Asynchronously reads the stdin and stores it as a string,
 * it can later be retrieved with getStringFromStdin.
 */
export function readStdin(program: ProgramLike): Promise<void> {
  return new Promise((resolvePromise) => {
    // `--no-pipe` is registered as a plain negated Option (cli.ts), so Commander maps it to
    // `pipe === false` rather than `nopipe === true` — see EXT-39. Both spellings mean the same
    // thing: skip the piped-stdin wait.
    const nopipe = program.getOptionValue('nopipe') || program.getOptionValue('pipe') === false;
    if (stdin.isTTY || nopipe) {
      program.parseAsync().then(() => resolvePromise());
    } else {
      // Support piping diff into gsloth
      const progressIndicator = new ProgressIndicator('reading STDIN', true);

      stdin.on('readable', function (this: NodeJS.ReadStream) {
        const chunk = this.read();
        progressIndicator.indicate();
        if (chunk !== null) {
          const chunkStr = chunk.toString('utf8');
          innerState.stringFromStdin = innerState.stringFromStdin + chunkStr;
        }
      });

      stdin.on('end', function () {
        program.parseAsync(argv).then(() => resolvePromise());
      });
    }
  });
}

// Console-related functions
export const log = (message: string): void => console.log(message);
export const error = (message: string): void => console.error(message);
export const warn = (message: string): void => console.warn(message);
export const info = (message: string): void => console.info(message);
export const debug = (message: string): void => console.debug(message);
export const stream = (chunk: string): boolean => process.stdout.write(chunk);
export async function execAsync(command: string): Promise<string> {
  const { exec } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
        reject(new Error(stderr));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export function getSlothVersion(): string {
  const installDir = getInstallDir();
  const jsonPath = resolve(installDir, 'package.json');
  const projectJson = readFileSync(jsonPath, { encoding: 'utf8' });
  return JSON.parse(projectJson).version;
}
