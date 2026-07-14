import { StatusLevel, StatusUpdateCallback } from '#src/core/types.js';
import * as su from '#src/utils/systemUtils.js';
import { closeLogStream, initLogStream, stream, writeToLogStream } from '#src/utils/systemUtils.js';
import { debugLog } from '#src/utils/debugUtils.js';

// Internal state for session logging
interface LoggingState {
  sessionLogFile?: string;
  enableSessionLogging: boolean;
}

// Internal state for console level control
interface ConsoleLevelState {
  currentLevel: StatusLevel;
}

const loggingState: LoggingState = {
  sessionLogFile: undefined,
  enableSessionLogging: false,
};

const consoleLevelState: ConsoleLevelState = {
  currentLevel: StatusLevel.INFO, // Default to INFO level, not debug
};

// ANSI color codes
const ANSI_COLORS = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

// Helper functions for ANSI coloring
function colorText(text: string, color: keyof typeof ANSI_COLORS): string {
  if (!su.getUseColour()) {
    return text;
  }
  return `${ANSI_COLORS[color]}${text}${ANSI_COLORS.reset}`;
}

// Stream-based logging function
const writeToSessionLog = (message: string): void => {
  if (loggingState.enableSessionLogging) {
    // Strip ANSI color codes before logging to file
    const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, '');
    writeToLogStream(cleanMessage);
  }
};

// Public functions for session logging management
export const initSessionLogging = (logFileName: string, enableLogging: boolean): void => {
  loggingState.sessionLogFile = enableLogging ? logFileName : undefined;
  loggingState.enableSessionLogging = enableLogging;

  if (enableLogging && logFileName) {
    initLogStream(logFileName);
  }
};

/**
 * Set the console logging level.
 * Only messages at or above this level will be displayed.
 * @param level - The minimum level to display
 */
export const setConsoleLevel = (level: StatusLevel): void => {
  consoleLevelState.currentLevel = level;
};

/**
 * Get the current console logging level.
 * @returns The current console level
 */
export const getConsoleLevel = (): StatusLevel => {
  return consoleLevelState.currentLevel;
};

/**
 * Reset console level to default (INFO) for testing purposes
 */
export const resetConsoleLevel = (): void => {
  consoleLevelState.currentLevel = StatusLevel.INFO;
};

/**
 * Check if a given status level should be displayed based on current console level.
 * @param level - The status level to check
 * @returns true if the level should be displayed
 */
function shouldDisplayLevel(level: StatusLevel): boolean {
  // Use enum values for comparison (higher values = more verbose)
  return level >= consoleLevelState.currentLevel;
}

export const flushSessionLog = (): void => {
  // Streams auto-flush, so this is now a no-op for API compatibility
  // Could potentially force flush if needed in the future
};

export const stopSessionLogging = (): void => {
  closeLogStream();
  loggingState.sessionLogFile = undefined;
  loggingState.enableSessionLogging = false;
};

export function displayError(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.ERROR)) return;
  const coloredMessage = colorText(message, 'red');
  writeToSessionLog(message + '\n');
  su.log(coloredMessage);
}

/**
 * Optional capture buffer for warning advisories (TUI-C19). When a capture window is open
 * (see {@link beginWarningCapture}), every {@link displayWarning} message is also collected
 * here so a surface that takes over the screen — the Ink TUI — can re-surface warnings that
 * would otherwise print once and scroll out of sight. `null` when no window is open, so the
 * plain-CLI path and the session log are entirely untouched.
 */
let warningCapture: string[] | null = null;

/**
 * Open a warning-capture window: from now until {@link endWarningCapture}, each
 * `displayWarning` message is buffered (IN ADDITION to being printed/logged as usual). Used by
 * the TUI session module to grab the transient load-time config advisories and thread them into
 * the persistent notice surface. Idempotent-ish: a second call starts a fresh buffer.
 */
export const beginWarningCapture = (): void => {
  warningCapture = [];
};

/**
 * Close the warning-capture window opened by {@link beginWarningCapture} and return everything
 * collected (empty array if none / never opened). Always call this — a `try/finally` around the
 * captured work — so a throw can't leak the capture state into later warnings.
 */
export const endWarningCapture = (): string[] => {
  const captured = warningCapture ?? [];
  warningCapture = null;
  return captured;
};

export function displayWarning(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.WARNING)) return;
  // Collect into the active capture window (if any) so the TUI can re-surface it later. Done
  // after the level guard so a user who quieted warnings sees them neither printed nor captured.
  if (warningCapture) warningCapture.push(message);
  const coloredMessage = colorText(message, 'yellow');
  writeToSessionLog(message + '\n');
  su.warn(coloredMessage);
}

export function displaySuccess(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.SUCCESS)) return;
  const coloredMessage = colorText(message, 'green');
  writeToSessionLog(message + '\n');
  su.log(coloredMessage);
}

export function displayInfo(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.INFO)) return;
  const coloredMessage = colorText(message, 'dim');
  writeToSessionLog(message + '\n');
  su.info(coloredMessage);
}

export function display(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.DISPLAY)) return;
  writeToSessionLog(message + '\n');
  su.log(message);
}

export function formatInputPrompt(message: string): string {
  return colorText(message, 'magenta');
}

/**
 * Display a debug message to the console and log it.
 * This function also integrates with debugUtils to output logs when at debug level.
 * Note: There is also a dedicated debug() function in debugUtils for more detailed logging.
 * @param message - The message to display (string, Error, or undefined)
 */
export function displayDebug(message: string | Error | undefined): void {
  if (!shouldDisplayLevel(StatusLevel.DEBUG)) return;
  if (message instanceof Error) {
    const stackTrace = message.stack || '';
    writeToSessionLog(stackTrace + '\n');
    su.debug(stackTrace);
    // Also log to debugUtils when at debug level
    debugLog(stackTrace);
  } else if (message !== undefined) {
    writeToSessionLog(message + '\n');
    su.debug(message);
    // Also log to debugUtils when at debug level
    debugLog(message);
  }
}

// Create status update callback
export const defaultStatusCallback: StatusUpdateCallback = (
  level: StatusLevel,
  message: string
) => {
  switch (level) {
    case StatusLevel.INFO:
      displayInfo(message);
      break;
    case StatusLevel.WARNING:
      displayWarning(message);
      break;
    case StatusLevel.ERROR:
      displayError(message);
      break;
    case StatusLevel.SUCCESS:
      displaySuccess(message);
      break;
    case StatusLevel.DEBUG:
      displayDebug(message);
      break;
    case StatusLevel.DISPLAY:
      display(message);
      break;
    case StatusLevel.STREAM:
      if (shouldDisplayLevel(StatusLevel.STREAM)) {
        writeToSessionLog(message);
        stream(message);
      }
      break;
  }
};
/**
 * Result of attempting to parse a CLI value as boolean-or-string.
 * When kind === 'boolean', value is a boolean.
 * When kind === 'string', value is a non-empty string.
 * When kind === 'none', no usable value was provided (undefined/null/empty).
 */
export type BooleanOrStringParseResult =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'none' };

/**
 * Parse a CLI option value into either:
 * - a boolean (when value looks like a true/false token),
 * - a non-empty string (otherwise),
 * - or none (when value is nullish or only whitespace).
 *
 * Recognized false-like tokens (case-insensitive): 'false', '0', 'n', 'no'
 * Recognized true-like tokens (case-insensitive):  'true', '1', 'y', 'yes'
 *
 * Examples:
 *  parseBooleanOrString('n')         => { kind: 'boolean', value: false }
 *  parseBooleanOrString('0')         => { kind: 'boolean', value: false }
 *  parseBooleanOrString('true')      => { kind: 'boolean', value: true }
 *  parseBooleanOrString('1')         => { kind: 'boolean', value: true }
 *  parseBooleanOrString('review.md') => { kind: 'string',  value: 'review.md' }
 *  parseBooleanOrString('  ')        => { kind: 'none' }
 *  parseBooleanOrString(undefined)   => { kind: 'none' }
 */
export function parseBooleanOrString(value: unknown): BooleanOrStringParseResult {
  if (value === undefined || value === null) {
    return { kind: 'none' };
  }

  const str = String(value);
  const trimmed = str.trim();
  if (trimmed.length === 0) {
    return { kind: 'none' };
  }

  const lower = trimmed.toLowerCase();

  // False-like tokens
  if (lower === 'false' || lower === '0' || lower === 'n' || lower === 'no') {
    return { kind: 'boolean', value: false };
  }

  // True-like tokens
  if (lower === 'true' || lower === '1' || lower === 'y' || lower === 'yes') {
    return { kind: 'boolean', value: true };
  }

  // Otherwise, treat as a string (e.g., filename/path)
  return { kind: 'string', value: trimmed };
}

/**
 * Convenience wrapper that returns a union directly instead of the tagged result.
 *
 * Returns:
 * - boolean when the input is a boolean-like token
 * - string when the input is non-empty and not a boolean-like token
 * - undefined when the input is nullish or empty/whitespace
 */
export function coerceBooleanOrString(value: unknown): boolean | string | undefined {
  const parsed = parseBooleanOrString(value);
  switch (parsed.kind) {
    case 'boolean':
      return parsed.value;
    case 'string':
      return parsed.value;
    default:
      return undefined;
  }
}
