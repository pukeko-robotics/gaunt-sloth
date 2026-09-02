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

/**
 * ANSI color codes — the 16-colour slots only, deliberately. A 16-colour slot is rendered with the
 * user's OWN terminal theme colour, so output looks native in light and dark schemes alike; a
 * 256-colour or 24-bit escape would pin us to one palette and clash with half of them.
 *
 * Exported so the surfaces that build their own pre-styled blocks (rather than passing a whole
 * message through {@link colorText}) still draw from this one table — see
 * `core/launchBanner.ts`, which paints only the face half of each banner row.
 *
 * `as const` because `packages/core` publishes `"./*.js": "./dist/*.js"`, so this is PUBLIC API of a
 * published package: without it any consumer could assign `ANSI_COLORS.magenta` and repaint the
 * whole CLI from the outside. Read-only, one table, no remote control.
 */
export const ANSI_COLORS = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

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

/**
 * TUI-C30 — print one pre-styled tool-call indication block (the plain surface's compact
 * `✓ name(args…)` + greyed preview, built by `core/plainToolIndication.ts`). Same INFO-level
 * gate, stdout channel and session-log treatment as {@link displayInfo} — matching the stream
 * discipline of the existing tool notices — but WITHOUT the blanket dim wrap: the block styles
 * each line itself (diff colours, per-line dim), and an outer wrapper would be broken by the
 * inner resets. The session log gets the ANSI-stripped text via {@link writeToSessionLog}.
 */
export function displayToolIndication(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.INFO)) return;
  writeToSessionLog(message + '\n');
  su.info(message);
}

/**
 * TUI-C33 — print the interactive-launch banner (the pre-styled block built by
 * `core/launchBanner.ts`) on the plain surface. Same DISPLAY-level gate and stdout channel as
 * {@link display}, so a quieted console silences it too, but deliberately NOT routed through
 * {@link writeToSessionLog}: the session log is a transcript of the conversation, not a screenshot
 * of the screen, and a five-row sloth at the top of it is noise. The block also styles itself (the
 * face half of each row carries the colour), so no outer wrap is applied.
 */
export function displayLaunchBanner(message: string): void {
  if (!shouldDisplayLevel(StatusLevel.DISPLAY)) return;
  su.log(message);
}

export function formatInputPrompt(message: string): string {
  return colorText(message, 'magenta');
}

/**
 * How loud one line of an interactive dialog is — its COLOUR, and nothing else.
 *
 * The other `display*` helpers bind a colour to a stream: picking red means picking stdout, picking
 * yellow means picking stderr. A dialog needs both halves independently, so this names the half that
 * is about appearance and leaves the stream to {@link displayDialogLine}, which always chooses the
 * same one.
 *
 * `notice`/`warn`/`danger` are the three tones `core/shell/escalationSeverity` grades an escalation
 * with, so a surface can pass a rater outcome's tone straight through; `plain` is text with no
 * severity (the framed command, a blank spacer) and `prompt` is the line the human types their
 * answer after.
 */
export type DialogTone = 'plain' | 'notice' | 'warn' | 'danger' | 'prompt';

const DIALOG_TONE_COLOURS: Record<DialogTone, keyof typeof ANSI_COLORS | null> = {
  plain: null,
  notice: 'dim',
  warn: 'yellow',
  danger: 'red',
  prompt: 'magenta',
};

/**
 * Print one line of an interactive dialog — an approval prompt, an attack banner — **on stderr**.
 *
 * ## One dialog, one stream
 *
 * A dialog's meaning is carried by the ORDER of its lines: a heading, then whose words the next
 * lines are, then the words. Two streams cannot promise an order. Only writes to the *same* stream
 * are delivered in the order they were made — across stdout and stderr nothing is promised, and the
 * difference is observable the moment the two go to different places: with stdout a pipe or a file
 * it is block-buffered while stderr is not, so a captured run can carry a rater's answer above the
 * command it answers. A security dialog whose line order holds only on a terminal is not a gate, so
 * every line of one goes through here and through nothing else.
 *
 * **stderr, because a prompt is not program output.** It is the conventional home for interaction,
 * it is not block-buffered, and it leaves stdout carrying only what the run produced. The cost is
 * real and is documented for users: piping stdout (`gth code --no-tui | tee log`) no longer captures
 * the dialog — the terminal still shows it, `2>` still collects it, and an enabled session log still
 * records it. The log write here is UNCONDITIONAL, which the gated helpers' is not: theirs sits
 * behind the level guard, so a quieted console drops those lines from the transcript as well as
 * from the screen. A dialog stays whole in both places.
 *
 * ## Not level-gated, on purpose
 *
 * The dialog is a QUESTION, not a status message, and the level filter is per line: gated, a quieted
 * console prints the parts above its threshold and drops the rest, which is how an approval prompt
 * comes to show a severity heading with no command under it. Half a dialog is worse than none,
 * because it still looks like a whole one.
 */
export function displayDialogLine(message: string, tone: DialogTone = 'plain'): void {
  const colour = DIALOG_TONE_COLOURS[tone];
  writeToSessionLog(message + '\n');
  su.error(colour ? colorText(message, colour) : message);
}

/**
 * How loud a NOTICE is — the title's colour, and the marker that says the same thing in the text.
 *
 * Two tones, matching the `SlashCommandNotice` vocabulary the surfaces already build notices with,
 * so a builder's tone passes straight through instead of being re-derived here.
 */
export type NoticeTone = 'info' | 'warn';

/**
 * The warn tone, said in the text rather than in the colour.
 *
 * Colour is the first thing a surface loses — `NO_COLOR`, a pipe, a monochrome terminal, a reader
 * who cannot distinguish yellow from grey — and a severity that exists only in the colour is a
 * severity those readers never receive. `⚠` is the marker the rest of the CLI already uses for
 * exactly this (`core/shell/escalationSeverity`, `core/toolDisplay`, `core/shell/framing`), so this
 * adds no second vocabulary for the same idea.
 *
 * Applied by {@link displayNotice} at render time and never written into the notice VALUE: the same
 * `title` travels to the Ink TUI, ACP and AG-UI, and a marker baked into the value would reach all
 * of them as data rather than as presentation. AG-UI keeps the classification by shipping the whole
 * notice object; ACP receives the title and body joined into one text block. The Ink TUI marks tone
 * by COLOUR ALONE (`CommandNotice`'s yellow-vs-cyan title), so under `NO_COLOR` a warn notice there
 * is indistinguishable from an info one — a known TUI-C14 residual, NOT something this marker
 * covers.
 */
export const NOTICE_WARN_MARKER = '⚠ ';

const NOTICE_TONE_COLOURS: Record<NoticeTone, keyof typeof ANSI_COLORS> = {
  info: 'dim',
  warn: 'yellow',
};

/**
 * When `consoleLevel` may silence a notice: at a {@link StatusLevel}, or never.
 *
 * A level here gates the WHOLE notice — see {@link displayNotice} — so it can never mean "some of
 * this notice".
 */
export type NoticeGate = StatusLevel | 'always';

/**
 * Print one whole NOTICE — a title and its body lines — **on stderr**.
 *
 * ## One notice, one stream
 *
 * A notice is a title that names something and body lines that are the substance of it; neither
 * half is usable alone. Written through the ordinary helpers it is written across BOTH streams,
 * because those bind colour to stream: a title coloured with `displayWarning` is yellow AND stderr,
 * while `display` body lines are stdout. On a terminal both go to the same place and nothing shows;
 * redirect one and the notice tears in half — the reader keeps *"Run ended"* with no reason code
 * while the file keeps the reason code with no notice.
 *
 * So a notice takes its title and its lines together and writes them through one call. The split
 * cannot be reintroduced by a caller, because a caller no longer chooses per line.
 *
 * **stderr, because a notice is commentary on the run and not the run's output.** It is where
 * `displayWarning` already writes, and that is the only one of the ordinary helpers that does —
 * even `displayError`, the loudest of them, is red but goes to stdout. It is unbuffered, and it
 * leaves stdout carrying only what the command produced — so `gth ask … > answer.txt` gets an
 * answer file that is the answer, with the whole explanation of a bad ending still on the screen
 * and still collectable with `2>`.
 * It also keeps a notice on the same stream as the approval dialog it sits beside on the readline
 * surface ({@link displayDialogLine}); split across two, those two related blocks can arrive in an
 * order neither of them was written in.
 *
 * The session log gets every line UNCONDITIONALLY, gate or no gate, so a quieted console never
 * costs the transcript a notice it did not show.
 *
 * ## The gate is per NOTICE, never per line
 *
 * `gate` is checked once, before the first line is written, and decides the whole notice. That is
 * the property, not an implementation detail: the level filter applied per line is what let a
 * quieted console print a title with no body under it (and, at `display` level, a body with no
 * title over it), which still looks like a whole notice and is not one.
 *
 * `'always'` is for a notice whose absence cannot be recovered by the reader — the termination
 * notice carries the one token a bug report needs, and the session log that would otherwise hold it
 * is off by default. A notice the user asked for by typing a command is not that: it is gated at
 * its own tone's level, and re-running the command after un-quieting the console brings it back.
 */
export function displayNotice(
  title: string,
  lines: readonly string[],
  options: { tone?: NoticeTone; gate?: NoticeGate } = {}
): void {
  const tone = options.tone ?? 'info';
  const gate = options.gate ?? (tone === 'warn' ? StatusLevel.WARNING : StatusLevel.INFO);
  // Decided ONCE, for the whole notice, before anything is written.
  const show = gate === 'always' || shouldDisplayLevel(gate);
  const rows: Array<{ text: string; colour: keyof typeof ANSI_COLORS | null }> = [
    {
      text: tone === 'warn' ? `${NOTICE_WARN_MARKER}${title}` : title,
      colour: NOTICE_TONE_COLOURS[tone],
    },
    ...lines.map((line) => ({ text: `  ${line}`, colour: null })),
  ];
  for (const row of rows) {
    writeToSessionLog(row.text + '\n');
    if (show) su.error(row.colour ? colorText(row.text, row.colour) : row.text);
  }
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
  { kind: 'boolean'; value: boolean } | { kind: 'string'; value: string } | { kind: 'none' };

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
