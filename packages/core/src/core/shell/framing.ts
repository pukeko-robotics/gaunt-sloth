/**
 * @module core/shell/framing
 *
 * [[TUI-C26]] (spec §6) — **how untrusted text is made safe to LOOK AT on the approval dialog.**
 *
 * Two of the strings on that dialog are written by something other than the user: the command the
 * agent proposed, and the auto-rater's `reason` for escalating it. Both are rendered to a terminal,
 * where a string is not inert: a carriage return moves the cursor to column 0, an escape sequence
 * moves it anywhere or clears the screen, and a newline alone is enough to lay down a line that
 * looks exactly like the dialog's own chrome. A prompt whose menu can be forged by the text it is
 * asking about is not a gate.
 *
 * ## Framing, not truncation
 *
 * The obvious mitigation — clamp the command to one line — is **wrong here, and it is wrong for a
 * measured reason.** On 2026-07-30 a `git commit` destroyed a home subtree because a backticked
 * `rm -rf` sat roughly fifteen lines into a twenty-five-line commit message, inside double quotes,
 * where bash expands it. A single-line clamp throws away exactly the span the human is being asked
 * to rule on while still looking like a complete prompt — and every model tested rated that command
 * `safe`, so the dialog is the last line of defence. A clamp does not even buy immunity: newlines
 * forge chrome with no escape sequences at all, one very long line wraps and pushes real chrome off
 * the screen, and a trailing `approved by rater` fits on one line untouched.
 *
 * So nothing here discards a line to defeat impersonation. Four rules do it instead:
 *
 * 1. **Neutralise control characters and ANSI, unconditionally** ({@link neutralizeUntrustedText}).
 * 2. **Every line renders inside a renderer-owned gutter carrying its line number**, so untrusted
 *    text cannot reach column 0 and an injected line cannot sit flush-left like real chrome. Long
 *    lines are wrapped *here*, with a gutter on every physical row, because a terminal's own wrap
 *    puts the continuation back at column 0.
 * 3. **The decision-relevant sites are extracted and listed ABOVE the body**, with their line
 *    numbers ({@link findUnresolvableSites}) — every command substitution and every composition
 *    boundary. This is what makes the eye land on the payload instead of on line one of a prose
 *    paragraph, and it is the concrete form of *"show why the gate could not statically resolve the
 *    command, at the position where it could not"*.
 * 4. **When a command is too long to show whole, elide AROUND the flagged sites** — never from the
 *    start — and state how many lines were hidden.
 *
 * ## Why the neutraliser matches characters and never sequences
 *
 * There is no ANSI-sequence parser here on purpose. An escape sequence cannot exist without its
 * introducer: `ESC` (U+001B) or the one-byte `CSI` (U+009B). Escape every character in the control
 * and format categories and every sequence dies with them, leaving `\x1b[2J` on the screen as five
 * printable characters that say precisely what was in the string. A sequence-matching regex, by
 * contrast, is a parser in the decision path — and a parser in a decision path is measured to leak:
 * the same repo's shell-scanning experiment leaked six of twelve attacks with an escape-precise
 * scanner and none with a rule too simple to have a blind spot.
 *
 * The same argument is why TAB is escaped rather than expanded. A tab's display width depends on
 * the column it lands in, so a tab inside a budgeted line makes the width arithmetic — the thing the
 * column-0 guarantee rests on — unanswerable. Escaping it removes the whole class of error, and
 * costs only the appearance of an indent.
 *
 * ## What the column-0 guarantee promises, and what it assumes
 *
 * **Promise:** for any `width` of at least {@link MIN_FRAME_WIDTH}, every row this module returns
 * fits the `width` it was given, so a terminal of that width never wraps one — and therefore no
 * byte of untrusted text is ever drawn at column 0, where the dialog's own chrome lives.
 *
 * It rests on exactly three things, and each is held here rather than hoped for:
 *
 * 1. **The surface must paint the rows verbatim, one row per line, and never re-wrap them.** A
 *    second wrap re-creates the flush-left continuation this module exists to remove. Both surfaces
 *    do this deliberately (one Ink `<Text>` per row; one `display()` call per row).
 * 2. **The surface must pass the real terminal width.** Rows are budgeted against what it passes,
 *    not against what the terminal turns out to be.
 * 3. **The budget must not depend on how the terminal treats East-Asian *Ambiguous* characters.**
 *    That policy is a terminal setting this process cannot read: the gutter separators are
 *    Ambiguous, and so is much of what untrusted text can be made of. Every measurement and every
 *    cut here therefore goes through {@link maxDisplayWidth} / {@link sliceToMaxWidth}, which count
 *    Ambiguous as two columns — the widest any terminal renders them — so a row that fits fits under
 *    *either* policy. Measuring with the repo's default narrow policy would fit a row to one
 *    terminal and overrun another by up to its own length, and one column of overrun is a wrapped
 *    continuation carrying attacker-chosen bytes at column 0. The cost is under-fill on a
 *    narrow-rendering terminal, which is cosmetic.
 *
 * **Where it stops, and why the promise names a width:** a frame narrower than
 * {@link MIN_FRAME_WIDTH} cannot carry the gutter and a readable command at once, so below that the
 * renderer stops honouring the number it was given and keeps {@link MIN_CONTENT_WIDTH} columns of
 * content instead — shrinking the command to nothing would be its own way of hiding a payload. Two
 * consequences, and they are different things. A `width` argument smaller than the gutter plus that
 * floor gets rows wider than the argument, because the floor wins — which is why the promise above
 * is stated over arguments at or above {@link MIN_FRAME_WIDTH} rather than over every number. A
 * *terminal* narrower than {@link MIN_FRAME_WIDTH} gets rows wider than itself and wraps them, and
 * there the column-0 guarantee genuinely lapses. Both surfaces resolve their width through
 * {@link frameWidthFor}, which never returns less than {@link MIN_FRAME_WIDTH}, so only the second
 * case is reachable in production — and it is announced on screen rather than left to lapse
 * silently: see {@link narrowTerminalNotice}.
 */
import {
  displayWidth,
  firstCluster,
  maxDisplayWidth,
  sliceToMaxWidth,
} from '#src/utils/displayWidth.js';

/** Column count assumed when the surface cannot report one (not a TTY, a test, a pipe). */
export const DEFAULT_FRAME_WIDTH = 80;

/**
 * Narrowest frame the gutter will produce, however small the terminal claims to be.
 *
 * Below it the gutter eats the row and the command becomes unreadable, which is its own way of
 * hiding a payload — so a terminal narrower than this gets a frame it cannot fit rather than no
 * frame at all. That trade costs the column-0 guarantee, and {@link narrowTerminalNotice} is what
 * stops it costing it silently.
 */
export const MIN_FRAME_WIDTH = 20;

/**
 * The width to frame at on a terminal reporting `columns`.
 *
 * One column is held back because a row that fills the last cell wraps on some terminals, and the
 * result is floored at {@link MIN_FRAME_WIDTH}. Both surfaces resolve their width here so they
 * cannot come to disagree about how much of a command a human was shown.
 */
export function frameWidthFor(columns: number | undefined): number {
  return Math.max(MIN_FRAME_WIDTH, usableColumns(columns) - 1);
}

/**
 * The line a surface must paint when the terminal is too narrow for the frame to fit in it, or
 * `undefined` when it fits.
 *
 * A guarantee that quietly stops holding is worse than one that says it stopped: below the floor
 * {@link frameWidthFor} keeps the frame readable at the cost of rows wider than the terminal, the
 * terminal wraps them, and a wrapped row puts untrusted text at column 0 — exactly what the gutter
 * exists to prevent. The human is told rather than shown a dialog that still looks like it is
 * guarding them.
 *
 * **Deliberately short, and only the consequence.** It is painted on a terminal of twenty columns
 * or fewer, so it wraps to a few rows however it is worded and every word it does not need is
 * another row of chrome between the reader and the command they are ruling on. It names what goes
 * wrong rather than the width that caused it, because the width is not what the reader has to
 * decide about; the reasoning belongs here, where it has room.
 */
export function narrowTerminalNotice(columns: number | undefined): string | undefined {
  if (usableColumns(columns) - 1 >= MIN_FRAME_WIDTH) return undefined;
  return '⚠ Terminal too narrow — text below can reach the left edge.';
}

/** What a surface reported, made usable: a positive whole number, or the default when unknown. */
function usableColumns(columns: number | undefined): number {
  return typeof columns === 'number' && Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : DEFAULT_FRAME_WIDTH;
}

/**
 * Body lines shown before {@link frameUntrustedCommand} starts eliding.
 *
 * Sized so the extracted-site notices, the body and the menu are on screen **together** on a
 * conventional 24-row terminal. That matters more than it looks: rule 3 puts the sites above the
 * body specifically so the eye lands on them, and a body long enough to scroll them off the top
 * defeats it. Bounding the body is safe here in a way the superseded single-line clamp was not,
 * because what is elided is chosen *around the flagged sites* and the count of hidden lines is
 * stated — the payload is what survives, not what is dropped.
 */
export const DEFAULT_FRAME_MAX_LINES = 20;

/** Lines kept either side of a flagged site when the body is elided. */
const SITE_CONTEXT_LINES = 2;

/** Sites listed individually in the notices before the rest are summarised as a count. */
const MAX_LISTED_SITES = 8;

/** Columns an extracted site's excerpt may occupy on its notice line. */
const SITE_EXCERPT_WIDTH = 48;

/** Indent the whole framed block sits at, before the gutter. */
const FRAME_INDENT = '  ';

/**
 * Separator between the line number and the untrusted content.
 *
 * This and {@link CONTINUATION_SEPARATOR} are East-Asian **Ambiguous**: one cell on most terminals,
 * two where the terminal is configured for a CJK locale. Nothing here depends on which — every row
 * is budgeted with the conservative ruler, so the glyphs may stay box-drawing without the guarantee
 * resting on a terminal setting. Measure the prefixes rather than assuming their width if you
 * change them.
 */
const GUTTER_SEPARATOR = '│';

/**
 * Separator on the continuation rows of a line too wide for the terminal. Deliberately different
 * from {@link GUTTER_SEPARATOR}: a wrapped row is not a new line of the command, and a reader who
 * cannot tell the two apart cannot trust the line numbers.
 */
const CONTINUATION_SEPARATOR = '┊';

/** Separator on the renderer's own "lines hidden" rows. */
const ELISION_SEPARATOR = '⋯';

/**
 * Smallest content width the gutter will leave, whatever the terminal claims.
 *
 * Exported alongside {@link wrapToWidth}, so the tests that pin the wrap's floor can state this
 * term rather than repeat the number and quietly drift from it.
 */
export const MIN_CONTENT_WIDTH = 4;

/** What made the gate unable to resolve a command statically, at one position in it. */
export type UntrustedSiteKind = 'command substitution' | 'composition';

/** One extracted decision-relevant position in a command. */
export interface UntrustedSite {
  /** 1-based line number, matching the gutter the body renders with. */
  line: number;
  /** 1-based display column within that line. */
  column: number;
  kind: UntrustedSiteKind;
  /** The literal token that was found — `$(`, a backtick, `&&`, `||`, `;` or `|`. */
  token: string;
  /** Neutralised text from the site onward, clipped for the notice line. */
  excerpt: string;
}

export interface FrameOptions {
  /** Terminal columns available. Rows are wrapped to fit; defaults to {@link DEFAULT_FRAME_WIDTH}. */
  width?: number;
  /** Body lines before elision; defaults to {@link DEFAULT_FRAME_MAX_LINES}. */
  maxLines?: number;
}

/** A block of untrusted text, ready to paint. */
export interface FramedUntrustedText {
  /**
   * Renderer-owned lines to paint **above** the body — the extracted sites, and the statement of
   * anything the elision hid. Empty when there is nothing to say.
   */
  notices: string[];
  /**
   * The body, one terminal row per element, each already carrying its gutter. A surface paints
   * these verbatim and must not re-wrap them: the gutter is the column-0 guarantee, and a second
   * wrap would put untrusted bytes back at column 0.
   */
  lines: string[];
  /** Every site {@link findUnresolvableSites} found, whether or not its line survived elision. */
  sites: UntrustedSite[];
}

/**
 * Replace every control and format character with a visible, printable escape.
 *
 * Covers the C0 and C1 control ranges (`\p{Cc}` — which is NUL, BEL, BS, TAB, LF, CR, ESC, DEL and
 * the 0x80–0x9F block including the one-byte CSI), the format characters (`\p{Cf}` — the bidi
 * overrides that reorder what a reader sees, the zero-width joiners, the BOM), and the line and
 * paragraph separators (`\p{Zl}`, `\p{Zp}`). Everything else is left exactly as written: this
 * neutralises, it never sanitises, so the text a human rules on is the text that was proposed.
 *
 * The output alphabet is `\`, `x`, `u`, `{`, `}` and hex digits, none of which is a shell
 * substitution or composition token — so escaping can neither create nor destroy a site that
 * {@link findUnresolvableSites} would report.
 */
export function neutralizeUntrustedText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, escapeCodePoint);
}

/** One code point as the printable escape this module renders unprintable things with. */
function escapeCodePoint(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0xff) return `\\x${codePoint.toString(16).padStart(2, '0')}`;
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  return `\\u{${codePoint.toString(16)}}`;
}

/**
 * Every code point of `text` as {@link escapeCodePoint} renders it — the same escape alphabet the
 * neutraliser uses, so what comes out is ASCII, one column per character under any width policy,
 * and still incapable of forming a substitution or composition token.
 */
function escapeCodePoints(text: string): string {
  return [...text].map(escapeCodePoint).join('');
}

/**
 * Collapse untrusted text to a single safe line, for the line-structured blocks that carry their
 * meaning in their line breaks (the §5 negotiation transcript, the rating prompt's own transcript).
 *
 * Neutralisation runs **first**: JavaScript's `\s` covers LF, CR and TAB but not ESC, BEL, NUL, the
 * C1 range or the bidi overrides, so collapsing whitespace alone leaves a screen-clearing sequence
 * intact on a line that merely looks tidy.
 */
export function neutralizeToOneLine(text: string): string {
  return neutralizeUntrustedText(text).replace(/\s+/gu, ' ').trim();
}

/**
 * Split untrusted text into the logical lines the gutter will number.
 *
 * `\r\n` is one break, because that is what a Windows-authored command means by it. A **lone** `\r`
 * is not treated as a break — it is left for {@link neutralizeUntrustedText} to make visible, since
 * a bare carriage return in a command is the cursor-to-column-0 overwrite trick far more often than
 * it is a line ending, and turning it into a break would hide that it was ever there.
 *
 * Exactly one trailing break is dropped: nearly every real multi-line command ends with one, and
 * numbering the empty line after it reads as a bug. A second trailing break is a genuinely empty
 * last line and is numbered like any other.
 */
function splitLogicalLines(text: string): string[] {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Every position in `command` at which the gate could not statically resolve it: each command
 * substitution (`$(` and a backtick) and each composition boundary (`;`, `&&`, `||`, `|`).
 *
 * **Deliberately not quote-aware.** A shell-accurate scanner would skip a `$(` inside single quotes
 * — and the command that motivated this whole surface hid its payload in backticks inside *double*
 * quotes, where the shell expands it. Over-reporting costs a line of notice; under-reporting is the
 * incident. The scan is the same order of simplicity as the ambiguity preflight that actually caught
 * that command, and for the same reason.
 *
 * Scanned over the neutralised lines so the reported line and column are the ones the reader can
 * count to on the screen.
 */
export function findUnresolvableSites(command: string): UntrustedSite[] {
  const sites: UntrustedSite[] = [];
  const lines = splitLogicalLines(command).map(neutralizeUntrustedText);
  lines.forEach((line, index) => {
    let cursor = 0;
    while (cursor < line.length) {
      const token = tokenAt(line, cursor);
      if (token === undefined) {
        cursor += 1;
        continue;
      }
      sites.push({
        line: index + 1,
        // A position for a human to count to, not a budget — so it is measured with the repo's
        // ordinary ruler rather than the conservative one. No row's width depends on it, and
        // reporting a column the reader cannot find would be the only thing over-counting bought.
        column: displayWidth(line.slice(0, cursor)) + 1,
        kind: token === '$(' || token === '`' ? 'command substitution' : 'composition',
        token,
        excerpt: clipToWidth(line.slice(cursor), SITE_EXCERPT_WIDTH),
      });
      cursor += token.length;
    }
  });
  return sites;
}

/**
 * The token starting at `cursor`, or `undefined`. Two-character tokens are tested first so `||` is
 * one composition boundary rather than two pipes.
 */
function tokenAt(line: string, cursor: number): string | undefined {
  const pair = line.slice(cursor, cursor + 2);
  if (pair === '$(' || pair === '&&' || pair === '||') return pair;
  const single = line[cursor];
  if (single === '`' || single === ';' || single === '|') return single;
  return undefined;
}

/** Marks a clip, and is itself Ambiguous — so its own column count has to be reserved, not assumed. */
const CLIP_MARKER = '…';

/**
 * `text` clipped to `width` columns, with {@link CLIP_MARKER} when anything was dropped.
 *
 * The marker's width is reserved from the budget rather than counted as one column: it is Ambiguous
 * like the separators, so a budget of `width - 1` would produce a row of `width + 1` on a terminal
 * that renders it wide — a clip that overruns the very width it was asked to fit.
 */
function clipToWidth(text: string, width: number): string {
  if (maxDisplayWidth(text) <= width) return text;
  const markerWidth = maxDisplayWidth(CLIP_MARKER);
  if (width < markerWidth) return sliceToMaxWidth(text, width);
  return `${sliceToMaxWidth(text, width - markerWidth)}${CLIP_MARKER}`;
}

/**
 * Frame the command the agent proposed: neutralised, gutter-numbered, wrapped to the terminal, its
 * unresolvable sites listed above it, and elided around those sites if it is too long to show whole.
 */
export function frameUntrustedCommand(
  command: string,
  options?: FrameOptions
): FramedUntrustedText {
  const sites = findUnresolvableSites(command);
  return frame(command, sites, options);
}

/**
 * Frame a block of untrusted prose — the auto-rater's `reason`, or what a sticky choice will store.
 *
 * The same gutter and the same neutralisation as a command, and for the same reason: the rater's
 * explanation is model-authored text on a dialog whose chrome it must not be able to forge. Site
 * extraction does not run, because prose has no composition boundaries to point at; a block with no
 * sites that overruns {@link FrameOptions.maxLines} keeps its head and states what it dropped.
 */
export function frameUntrustedText(text: string, options?: FrameOptions): FramedUntrustedText {
  return frame(text, [], options);
}

function frame(text: string, sites: UntrustedSite[], options?: FrameOptions): FramedUntrustedText {
  const width = Math.max(1, Math.floor(options?.width ?? DEFAULT_FRAME_WIDTH));
  const maxLines = Math.max(1, Math.floor(options?.maxLines ?? DEFAULT_FRAME_MAX_LINES));
  const logical = splitLogicalLines(text).map(neutralizeUntrustedText);

  const numberWidth = String(logical.length).length;
  // MEASURED, never counted. The separators are Ambiguous, so their column count is a terminal
  // setting rather than a constant, and a hardcoded arithmetic gutter is right on one terminal and
  // one column short on another — which is a wrapped row, which is untrusted text at column 0. The
  // widest of the three prefixes is used for all of them so the budget is right for every row shape
  // this renderer can emit, and so changing a glyph cannot silently re-open the gap.
  const gutterWidth = Math.max(
    maxDisplayWidth(bodyPrefix('9'.repeat(numberWidth), numberWidth)),
    maxDisplayWidth(continuationPrefix(numberWidth)),
    maxDisplayWidth(elisionPrefix(numberWidth))
  );
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - gutterWidth);

  const { windows, sitesHidden } = selectWindows(
    logical.length,
    sites.map((site) => site.line),
    maxLines
  );

  const lines: string[] = [];
  let previousEnd = 0;
  for (const window of windows) {
    if (window.start > previousEnd + 1) {
      lines.push(elisionRow(window.start - previousEnd - 1, numberWidth, width));
    }
    for (let number = window.start; number <= window.end; number++) {
      const rows = wrapToWidth(logical[number - 1], contentWidth);
      rows.forEach((row, rowIndex) => {
        lines.push(
          rowIndex === 0
            ? `${bodyPrefix(String(number), numberWidth)}${row}`
            : `${continuationPrefix(numberWidth)}${row}`
        );
      });
    }
    previousEnd = window.end;
  }
  if (previousEnd < logical.length) {
    lines.push(elisionRow(logical.length - previousEnd, numberWidth, width));
  }

  return { notices: buildNotices(sites, sitesHidden, width), lines, sites };
}

/** The prefix a numbered body row carries, before the untrusted content. */
function bodyPrefix(number: string, numberWidth: number): string {
  return `${FRAME_INDENT}${number.padStart(numberWidth)} ${GUTTER_SEPARATOR} `;
}

/** The prefix on the continuation rows of a line this renderer wrapped. */
function continuationPrefix(numberWidth: number): string {
  return `${FRAME_INDENT}${' '.repeat(numberWidth)} ${CONTINUATION_SEPARATOR} `;
}

/** The prefix on the renderer's own "lines hidden" rows. */
function elisionPrefix(numberWidth: number): string {
  return `${FRAME_INDENT}${' '.repeat(numberWidth)} ${ELISION_SEPARATOR} `;
}

/**
 * A renderer-owned row standing in for the lines the elision dropped, stating how many.
 *
 * Clipped to the terminal like every other row. It carries no untrusted text, so a wrap here would
 * be untidy rather than forgeable — but a renderer that bounds the rows it does not own and not the
 * ones it does is a renderer whose next row is bounded by accident.
 */
function elisionRow(hidden: number, numberWidth: number, width: number): string {
  return clipToWidth(
    `${elisionPrefix(numberWidth)}${hidden} ${hidden === 1 ? 'line' : 'lines'} hidden`,
    width
  );
}

/**
 * Which line ranges survive the {@link FrameOptions.maxLines} budget, and how many flagged sites
 * they leave hidden.
 *
 * **Never from the start.** With sites to point at, the budget buys windows around *them*, earliest
 * first, so the span the human is being asked to rule on is the span that survives — the opposite of
 * the head-clamp that let a payload fifteen lines in disappear. Only text with no flagged site at
 * all keeps its head, because there is then nothing to prefer.
 *
 * A window that will not fit stops the loop rather than being skipped: showing a later site while
 * silently dropping an earlier one would renumber the reader's sense of what is on screen. What is
 * dropped is counted and said out loud in the notices instead.
 */
function selectWindows(
  totalLines: number,
  siteLines: readonly number[],
  maxLines: number
): { windows: Array<{ start: number; end: number }>; sitesHidden: number } {
  if (totalLines <= maxLines) return { windows: [{ start: 1, end: totalLines }], sitesHidden: 0 };
  if (siteLines.length === 0) return { windows: [{ start: 1, end: maxLines }], sitesHidden: 0 };

  const merged: Array<{ start: number; end: number }> = [];
  for (const line of [...new Set(siteLines)].sort((a, b) => a - b)) {
    const start = Math.max(1, line - SITE_CONTEXT_LINES);
    const end = Math.min(totalLines, line + SITE_CONTEXT_LINES);
    const last = merged[merged.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }

  const windows: Array<{ start: number; end: number }> = [];
  let used = 0;
  for (const window of merged) {
    const size = window.end - window.start + 1;
    if (used + size > maxLines) break;
    windows.push(window);
    used += size;
  }
  // The first window alone can exceed the budget when many sites cluster. Keep it, clipped from the
  // first site forward, so a flagged line is never traded for a context line.
  if (windows.length === 0) {
    const first = Math.min(...siteLines);
    windows.push({ start: first, end: Math.min(totalLines, first + maxLines - 1) });
  }

  const shown = (line: number): boolean =>
    windows.some((window) => line >= window.start && line <= window.end);
  return { windows, sitesHidden: siteLines.filter((line) => !shown(line)).length };
}

/** The lines painted above the body: what was flagged, where, and what the elision hid. */
function buildNotices(
  sites: readonly UntrustedSite[],
  sitesHidden: number,
  width: number
): string[] {
  if (sites.length === 0) return [];
  const plural = sites.length === 1 ? 'site' : 'sites';
  // Clipped like the rows below it. This header is the renderer's own sentence and carries nothing
  // untrusted, so its overrun was cosmetic — but a block that bounds the attacker's rows and not its
  // own is bounded by coincidence, and the next row added here inherits the coincidence.
  const notices = [
    clipToWidth(
      `⚠ ${sites.length} ${plural} the gate could not statically resolve — ` +
        `${sites.length === 1 ? 'it is' : 'they are'} numbered in the command below:`,
      width
    ),
  ];
  for (const site of sites.slice(0, MAX_LISTED_SITES)) {
    const label = `    line ${site.line} · ${site.kind} ${site.token} · `;
    // Clipped TWICE, and the second clip is not belt-and-braces. The excerpt budget has a floor, so
    // on a narrow terminal the floor can win and hand back a row wider than the terminal — which
    // Ink then wraps, starting the continuation at column 0 with attacker-chosen excerpt bytes on
    // it. The body rows cannot reach that state (their gutter leaves content width above its own
    // minimum at every width a surface will pass), but this row can, and it is the one line here
    // that carries untrusted text outside the gutter. The whole row is bounded by the terminal.
    notices.push(
      clipToWidth(
        `${label}${clipToWidth(site.excerpt, Math.max(8, width - maxDisplayWidth(label)))}`,
        width
      )
    );
  }
  if (sites.length > MAX_LISTED_SITES) {
    const rest = sites.length - MAX_LISTED_SITES;
    notices.push(
      clipToWidth(
        `    ${CLIP_MARKER} and ${rest} further flagged ${rest === 1 ? 'site' : 'sites'}, ` +
          `up to line ${sites[sites.length - 1].line}.`,
        width
      )
    );
  }
  if (sitesHidden > 0) {
    notices.push(
      clipToWidth(
        `    ⚠ ${sitesHidden} flagged ${sitesHidden === 1 ? 'site sits' : 'sites sit'} on ` +
          'lines the elision below hid — this command is too long to show in full.',
        width
      )
    );
  }
  return notices;
}

/**
 * Split one logical line into terminal rows of at most `width` columns.
 *
 * The wrap belongs here rather than to the terminal because a terminal's own wrap starts the
 * continuation at column 0, which is the forgery this module exists to prevent: a single line long
 * enough to wrap can otherwise lay attacker-chosen bytes flush-left, gutter and all bypassed.
 *
 * Measured and cut with the display-width helpers, never `.length` — a CJK ideograph or an emoji is
 * one code point in two columns, and a row measured as fitting that does not fit is a row the
 * terminal wraps back to column 0. Conservatively, so the same holds on a terminal that renders
 * Ambiguous characters wide.
 *
 * The budget is floored at {@link MIN_CONTENT_WIDTH} here rather than taken on trust. The
 * over-wide-cluster branch below escapes a cluster it cannot draw and re-measures it, which
 * advances only if the budget can hold at least one escape character; at a budget of zero it
 * re-escapes its own backslashes forever and the row never terminates. {@link frame} does pass a
 * floored width, but a loop that terminates because of what its only caller happens to do is one
 * the next caller silently breaks.
 *
 * Exported for tests, which pin that termination at a degenerate width — the one width the public
 * entry points cannot produce.
 */
export function wrapToWidth(text: string, width: number): string[] {
  const budget = Math.max(MIN_CONTENT_WIDTH, width);
  if (maxDisplayWidth(text) <= budget) return [text];
  const rows: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const head = sliceToMaxWidth(rest, budget);
    if (head.length === 0) {
      // A grapheme cluster wider than the entire content budget cannot be drawn inside the gutter
      // at all, so it is shown the way this module shows anything else it cannot render safely:
      // as the printable escapes of its code points. Emitting the cluster raw would leave one row
      // unbounded — the terminal would wrap it, and the continuation would carry untrusted bytes at
      // column 0, which is the single thing this function exists to prevent.
      //
      // A LIVE path, not a dead guard. A grapheme cluster has no bounded column count: display
      // width sums additively across a run of Hangul leading jamo, and across the trailing spacing
      // marks of an Indic or halfwidth-kana cluster, so one cluster can measure arbitrarily many
      // columns. None of those code points is a control or format character, so the neutraliser
      // does not touch them and they arrive here whole — forty leading jamo are a single
      // eighty-column cluster, which overruns the content budget of a default eighty-column
      // terminal. Deleting this branch does not remove a dead case; it restores the unbounded row.
      //
      // It terminates: the escapes are ASCII, one column each under every policy, and the budget
      // is floored at MIN_CONTENT_WIDTH above, so the next pass slices a non-empty head and the
      // loop strictly advances.
      const cluster = firstCluster(rest);
      rest = `${escapeCodePoints(cluster)}${rest.slice(cluster.length)}`;
      continue;
    }
    rows.push(head);
    rest = rest.slice(head.length);
  }
  return rows;
}
