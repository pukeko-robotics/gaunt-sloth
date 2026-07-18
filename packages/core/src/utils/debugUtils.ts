import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';

const DEBUG_LOG_FILE = 'gaunt-sloth.log';
let debugEnabled = false;

/**
 * GS2-46 — bounded in-memory ring buffer of debug-log lines, populated by every `debugLog*`
 * variant UNCONDITIONALLY (independent of `debugEnabled`, which only gates the on-disk write
 * below). This is deliberately always-on and forward-looking: GS2-48 (crash handler) expects
 * "the last-N debugLog buffer lines already held in memory" to exist regardless of whether
 * `config.debugLog` was ever turned on for the session, and `/debug-dump` (GS2-46) surfaces it
 * verbatim. Capped so a long session can't grow this without bound.
 */
const DEBUG_LOG_BUFFER_MAX = 1000;
const debugLogBuffer: string[] = [];

/** Push one formatted line into the ring buffer, evicting the oldest entry once at capacity. */
function pushToDebugLogBuffer(entry: string): void {
  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > DEBUG_LOG_BUFFER_MAX) {
    debugLogBuffer.shift();
  }
}

/**
 * GS2-46 — read the current debug-log ring buffer (oldest first). Returns a copy so callers
 * (e.g. the `/debug-dump` writer) can't mutate the live buffer.
 */
export function getDebugLogBuffer(): string[] {
  return [...debugLogBuffer];
}

/**
 * Initialize debug logging based on config
 */
export function initDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
  if (debugEnabled) {
    // Ensure the log file directory exists
    const logPath = resolve(DEBUG_LOG_FILE);
    const logDir = dirname(logPath);
    try {
      mkdirSync(logDir, { recursive: true });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      // Directory might already exist, ignore error
    }

    // Log initialization
    debugLog('=== Debug logging initialized ===');
    debugLog(`Timestamp: ${new Date().toISOString()}`);
    debugLog(`Log file: ${logPath}`);
    debugLog('================================\n');
  }
}

/**
 * Log a debug message. Always pushed into the in-memory ring buffer (GS2-46); only appended to
 * the on-disk log file when debug logging is enabled.
 */
export function debugLog(message: string): void {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  pushToDebugLogBuffer(logEntry);

  if (!debugEnabled) return;

  try {
    appendFileSync(resolve(DEBUG_LOG_FILE), `${logEntry}\n`, 'utf8');
  } catch (error) {
    // Ignore logging errors to prevent breaking the main flow
    console.error('Failed to write to debug log:', error);
  }
}

/**
 * Log multiple lines with proper formatting. Always buffered (GS2-46); delegates to `debugLog`
 * for the on-disk gating.
 */
export function debugLogMultiline(title: string, content: string): void {
  debugLog(`=== ${title} ===`);
  debugLog(content);
  debugLog(`=== End ${title} ===\n`);
}

/**
 * Log an object using Node.js inspect with reasonable depth. Always buffered (GS2-46); delegates
 * to `debugLogMultiline`/`debugLog` for the on-disk gating.
 */
export function debugLogObject(title: string, obj: unknown): void {
  try {
    // Use Node.js inspect with reasonable depth and no colors for log files
    const formatted = inspect(obj, { showHidden: false, depth: 3, colors: false });
    debugLogMultiline(title, formatted);
  } catch (error) {
    debugLog(`Failed to inspect ${title}: ${error}`);
  }
}

/**
 * Log error with stack trace. Always buffered (GS2-46); delegates to `debugLog` for the on-disk
 * gating.
 */
export function debugLogError(context: string, error: unknown): void {
  debugLog(`❌ Error in ${context}:`);
  if (error instanceof Error) {
    debugLog(`  Message: ${error.message}`);
    if (error.stack) {
      debugLog('  Stack trace:');
      error.stack.split('\n').forEach((line) => debugLog(`    ${line}`));
    }
  } else {
    debugLog(`  Error: ${String(error)}`);
  }
  debugLog('');
}
