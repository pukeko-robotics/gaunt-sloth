/**
 * @module toolDisplay
 * TUI-C30 — the surface-agnostic tool-display registry: how a tool CALL is summarised
 * (`name(arg=val, …)`) and how its OUTPUT is previewed (up to {@link TOOL_OUTPUT_PREVIEW_LINES}
 * greyed lines, diff-coloured for `write_file`/`edit_file`), shared by BOTH render surfaces:
 *
 *  - the Ink TUI's `ToolCallPanel` (`packages/app/src/tui/components/LiveTurn.tsx`), and
 *  - the plain/readline (`--no-tui`, piped, single-shot) surface
 *    (`core/plainToolIndication.ts`).
 *
 * Everything here is PURE STRINGS plus a style tag per line ({@link ToolDisplayLine}), so the
 * module knows nothing about Ink or ANSI: the TUI maps styles to `<Text>` props and the plain
 * surface maps them to raw ANSI via {@link renderToolLineAnsi}. The shape mirrors vue-ui's
 * PLAT-17 `toolDisplay.ts` (name → glyph + which args to summarise + optional result formatter,
 * with a generic fallback — cf. openclaw's `TOOL_DISPLAY_CONFIG` and opencode's
 * `collapseToolOutput`) so the surfaces stay analogous without sharing code.
 *
 * Design rules (from the node spec):
 *  - **One canonical output cap: {@link TOOL_OUTPUT_PREVIEW_LINES} lines** (and a per-line char
 *    cap), applied by {@link capToolDisplayLines} with a `… (+N more lines)` overflow marker.
 *    This is a RENDER-time cap only — the model-facing `OutputBuffer`/EXT-9 head-tail caps are a
 *    separate layer beneath it and are never touched here.
 *  - **Secret redaction reuses the GS2-47 `redactSecrets` lineage** (literal env/config secrets +
 *    provider key patterns) — no new redactor. Applied to the params summary and every
 *    preview/body line, fail-safe (redact MORE on any error, never leak).
 *  - **`write_file`/`edit_file` render the change as a diff derived from the tool's ARGS**
 *    (added = `added` style/green, removed = `removed` style/red); monochrome keeps the `+`/`-`
 *    prefixes so the diff still reads without colour (DL-7 graceful degradation).
 */
import { collectSecretValues, redactText } from '#src/utils/redactSecrets.js';
import { env } from '#src/utils/systemUtils.js';

/** The single canonical output-preview cap (lines). No other preview length exists anywhere. */
export const TOOL_OUTPUT_PREVIEW_LINES = 10;

/** Per-line character cap for preview lines (a one-line minified bundle must not flood a row). */
export const TOOL_PREVIEW_LINE_MAX_CHARS = 200;

/** Per-value character cap inside a params summary. */
export const TOOL_PARAM_VALUE_MAX_CHARS = 48;

/** Whole params-summary character cap (everything inside the parentheses). */
export const TOOL_SUMMARY_MAX_CHARS = 120;

/** The overflow/truncation marker used everywhere in this module. */
export const ELLIPSIS = '…';

/**
 * Style tag for one rendered line. The two surfaces map these to their own colour systems
 * (Ink `<Text>` props / raw ANSI): `dim` = greyed preview text, `added`/`removed` = diff
 * green/red. DL-8 colour semantics; monochrome surfaces render the raw text unchanged.
 */
export type ToolDisplayStyle = 'dim' | 'added' | 'removed';

/** One line of a tool call's rendered body/preview. */
export interface ToolDisplayLine {
  text: string;
  style: ToolDisplayStyle;
}

/**
 * Everything a formatter may look at for one tool call. Both surfaces build this from their
 * own state (the TUI from `ToolCallViewModel`, the plain surface from the message stream).
 */
export interface ToolCallDisplayInput {
  /** The gth tool name (`read_file`, `run_shell_command`, a custom tool's name). */
  name: string;
  /** The raw streamed args JSON (possibly partial mid-stream, possibly invalid). */
  argsText?: string;
  /** The final model-facing tool result, when it has arrived. */
  result?: string;
  /** Live streamed child output (TUI only — the `tool_output` channel's accumulation). */
  output?: string;
  /** The real `ToolMessage.status === 'error'` signal (TUI-C7) — never sniffed from text. */
  isError?: boolean;
  /**
   * True when the live child output ALREADY streamed raw to the user's terminal (the plain
   * surface's default sink). Formatters then suppress the duplicated output body and render
   * only the closing status — the TUI-C17 "output AND result repeat each other" dedupe.
   */
  liveOutputAlreadyShown?: boolean;
}

/** One registry entry: glyph + which args the summary shows + an optional body formatter. */
interface ToolDisplayEntry {
  /** Leading glyph for the call line (falls back to {@link FALLBACK_GLYPH}). */
  glyph?: string;
  /**
   * TUI-C32 residual c — this tool genuinely emits the shell result shape (`<COMMAND_OUTPUT>…`),
   * so its child output streams live and the shell body formatter + live-output dedupe apply. A
   * REGISTERED tool that is NOT flagged is never shell-shaped even if its result happens to
   * contain the marker string (e.g. `read_file` reading a file that quotes `<COMMAND_OUTPUT>`).
   * Unregistered/custom tool names fall back to shape-detection (they own user-defined names and
   * DO share the shape — cf. `GthCustomToolkit`/`GthDevToolkit`).
   */
  shellShaped?: boolean;
  /**
   * Arg keys to include in the params summary, in order. `undefined` → all args in their
   * streamed order; `[]` → none (renders `name()`).
   */
  summariseArgs?: string[];
  /**
   * Optional per-tool body formatter. Returns the FULL (uncapped) body lines, or `null` to
   * fall through to the generic output+result rendering (e.g. when args are unparsable).
   */
  formatBody?: (
    input: ToolCallDisplayInput,
    args: Record<string, unknown> | null
  ) => ToolDisplayLine[] | null;
}

const FALLBACK_GLYPH = '⚙';
const FILE_GLYPH = '📁';
const SHELL_GLYPH = '🔧';

/* ------------------------------------------------------------------------- *
 * Small shared helpers                                                       *
 * ------------------------------------------------------------------------- */

/**
 * Tolerant parse of a (possibly partial) streamed args JSON. Mirrors the view-model's
 * defensive posture: a half-streamed or malformed buffer never throws — it returns `null`.
 */
export function parseToolArgsSafe(argsText: string | undefined): Record<string, unknown> | null {
  if (!argsText || !argsText.trim()) return null;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The live gth config, registered once per run so {@link getDefaultSecrets} can harvest INLINE
 * config secrets (a pasted `apiKey`/`token` value) via the GS2-47 config walk — not only the
 * env-derived literals. `GthAgentRunner.init` sets this next to the crash-context hand-off, so
 * both render surfaces (the plain observer and the Ink TUI) see it. `undefined` (no config yet)
 * degrades to env-only collection + the provider patterns, exactly as before.
 */
let displayConfig: unknown = undefined;

/**
 * Register the live config for inline-secret collection (TUI-C32 residual a). Resets the secret
 * cache so the next {@link getDefaultSecrets} recomputes with the config's inline literals folded
 * in. Idempotent; a later call with a fresh config supersedes the previous one.
 */
export function setToolDisplayConfig(config: unknown): void {
  displayConfig = config;
  cachedSecrets = null;
}

/**
 * Lazily-computed default secret literals for redaction (GS2-47 technique 1), harvested from the
 * process env AND the registered config (inline `apiKey`/`token` values) the same way
 * `/debug-dump` does. Cached because `collectSecretValues` walks the whole env + config; the set
 * cannot change mid-process in any way this render path must react to (a new config resets it via
 * {@link setToolDisplayConfig}). `redactText` additionally always applies the provider-key
 * patterns (technique 2).
 */
let cachedSecrets: string[] | null = null;
function getDefaultSecrets(): string[] {
  if (cachedSecrets === null) {
    try {
      cachedSecrets = collectSecretValues(displayConfig, env ?? {});
    } catch {
      cachedSecrets = []; // patterns still apply via redactText
    }
  }
  return cachedSecrets;
}

/** Test seam: drop the cached secret literals + registered config so specs can vary both. */
export function resetToolDisplaySecretsCacheForTests(): void {
  cachedSecrets = null;
  displayConfig = undefined;
}

/** Collapse whitespace runs (incl. newlines) so a value stays a one-line token. */
function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` characters with the {@link ELLIPSIS} marker. */
function truncate(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  return chars.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS;
}

/**
 * Render one arg value for the summary: strings inline+truncated, the rest JSON-ish.
 *
 * ORDER MATTERS (fix-cycle-1 finding): redaction runs BEFORE any transformation. Truncating
 * first would bisect a literal secret longer than the value cap so it no longer
 * literal-matches — its head would render in the call summary on both surfaces (a partial
 * leak); whitespace-collapsing first could likewise alter a literal out of matching. So:
 * redact the RAW text, then inline, then truncate (`<redacted>` contains no whitespace and is
 * shorter than the cap, so the later steps can never damage the marker).
 */
function formatParamValue(value: unknown, secrets: readonly string[]): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value === undefined) {
    text = 'undefined';
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return truncate(inline(redactText(text, secrets)), TOOL_PARAM_VALUE_MAX_CHARS);
}

/** Split into lines, dropping a single trailing newline's phantom empty last element. */
function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Map raw text lines to styled lines. */
function styled(lines: string[], style: ToolDisplayStyle): ToolDisplayLine[] {
  return lines.map((text) => ({ text, style }));
}

/* ------------------------------------------------------------------------- *
 * Shell-shaped results (<COMMAND_OUTPUT>) — run_* / run_shell_command /      *
 * custom toolkit tools all share this body shape, so it is detected by       *
 * SHAPE, not by name (custom tool names are user-defined).                   *
 * ------------------------------------------------------------------------- */

const COMMAND_OUTPUT_RE = /<COMMAND_OUTPUT>\n?([\s\S]*?)<\/COMMAND_OUTPUT>\n?([\s\S]*)$/;

/**
 * Parse the shared shell-result shape (`Executing '…'…\n\n<COMMAND_OUTPUT>…</COMMAND_OUTPUT>\n\n
 * <status line>`). Returns the captured output body and the trailing status text, or `null`
 * when the result is not shell-shaped.
 */
export function parseCommandOutputResult(
  result: string | undefined
): { body: string; tail: string } | null {
  if (!result) return null;
  const match = COMMAND_OUTPUT_RE.exec(result);
  if (!match) return null;
  return { body: match[1] ?? '', tail: (match[2] ?? '').trim() };
}

/**
 * TUI-C32 residual c — may this tool NAME be treated as shell-shaped at all? A registered entry
 * must be explicitly {@link ToolDisplayEntry.shellShaped}; an unregistered/custom name falls back
 * to shape-detection (custom toolkit tools own user-defined names yet share the result shape). A
 * registered non-shell tool (`read_file`, `list_directory`, …) is therefore NEVER shell-parsed
 * just because its result happens to contain the `<COMMAND_OUTPUT>` marker.
 */
function nameAllowsShellShape(name: string): boolean {
  const entry = TOOL_DISPLAY_REGISTRY[name];
  return entry ? entry.shellShaped === true : true;
}

/**
 * TUI-C32 residual c — is THIS tool call genuinely a shell-shaped result (name allows it AND the
 * result actually carries the `<COMMAND_OUTPUT>` shape)? Used by the plain surface to decide
 * `liveOutputAlreadyShown` (the child streamed live via the tool-output channel's default sink),
 * so a non-shell tool whose result merely quotes the marker no longer has its body suppressed.
 */
export function isShellShapedResult(name: string, result: string | undefined): boolean {
  return nameAllowsShellShape(name) && parseCommandOutputResult(result) !== null;
}

/**
 * Body formatter for shell-shaped calls: the child's output (preferring the LIVE streamed
 * output — verbatim what the child printed — over the result's `<COMMAND_OUTPUT>` copy of it,
 * which is the TUI-C17 dedupe) followed by the closing status line. When the live output
 * already streamed raw to the terminal (plain surface), only the status tail is rendered so
 * nothing the user just watched is repeated.
 */
function formatShellBody(input: ToolCallDisplayInput): ToolDisplayLine[] | null {
  const parsed = parseCommandOutputResult(input.result);
  // Not shell-shaped: only handle the still-running live-output case (a named run_* entry with
  // no result yet). Anything with a non-shell result falls through to the generic rendering so
  // e.g. a hardline refusal text is never dropped.
  if (!parsed && (input.result || !input.output)) return null;
  const lines: ToolDisplayLine[] = [];
  if (!input.liveOutputAlreadyShown) {
    // TUI-C32 residual d — the streamed live output is normally the verbatim, most-complete copy,
    // so it is preferred (TUI-C17 dedupe). But if the live channel dropped straggler/tail chunks
    // it can be a strict PREFIX of the result's `<COMMAND_OUTPUT>` copy (which the model always
    // receives in full) — in that case fall back to the fuller copy so the expanded view can still
    // recover what the stream missed. The common case (live === result, an independent/capped
    // result, or an empty live output) is unchanged: only a genuine dropped-tail prefix overrides.
    const live = input.output ?? '';
    const resultBody = parsed?.body ?? '';
    const body = resultBody.length > live.length && resultBody.startsWith(live) ? resultBody : live;
    if (body.trim().length > 0) lines.push(...styled(toLines(body), 'dim'));
  }
  if (parsed && parsed.tail.length > 0) {
    lines.push(...styled(toLines(parsed.tail), 'dim'));
  }
  return lines.length > 0 ? lines : null;
}

/* ------------------------------------------------------------------------- *
 * write_file / edit_file — diff-coloured rendering derived from the ARGS     *
 * ------------------------------------------------------------------------- */

/** `write_file` body: every content line is an ADDED diff line (there is no old content). */
function formatWriteFileBody(
  input: ToolCallDisplayInput,
  args: Record<string, unknown> | null
): ToolDisplayLine[] | null {
  if (input.isError) return null; // fall through: the error text is the story, not the diff
  const content = args?.content;
  if (typeof content !== 'string') return null;
  const lines = styled(
    toLines(content).map((l) => `+ ${l}`),
    'added'
  );
  if (input.result && input.result.trim().length > 0) {
    lines.push(...styled(toLines(input.result.trim()), 'dim'));
  }
  return lines;
}

/** `edit_file` body: per edit, the removed oldText lines then the added newText lines. */
function formatEditFileBody(
  input: ToolCallDisplayInput,
  args: Record<string, unknown> | null
): ToolDisplayLine[] | null {
  if (input.isError) return null; // fall through: show the recoverable error text instead
  const edits = args?.edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const lines: ToolDisplayLine[] = [];
  let rendered = 0;
  for (const raw of edits) {
    const oldText = (raw as { oldText?: unknown })?.oldText;
    const newText = (raw as { newText?: unknown })?.newText;
    if (typeof oldText !== 'string' || typeof newText !== 'string') continue;
    if (rendered > 0) lines.push({ text: `${ELLIPSIS}`, style: 'dim' }); // hunk separator
    rendered += 1;
    lines.push(
      ...styled(
        toLines(oldText).map((l) => `- ${l}`),
        'removed'
      )
    );
    lines.push(
      ...styled(
        toLines(newText).map((l) => `+ ${l}`),
        'added'
      )
    );
  }
  return rendered > 0 ? lines : null;
}

/* ------------------------------------------------------------------------- *
 * The registry                                                               *
 * ------------------------------------------------------------------------- */

/**
 * Named entries. Anything not listed uses the generic fallback (all args summarised,
 * output+result previewed dim) — plus the SHAPE-based shell formatter, which also covers
 * user-named custom toolkit tools (they share the `<COMMAND_OUTPUT>` result shape).
 */
const TOOL_DISPLAY_REGISTRY: Record<string, ToolDisplayEntry> = {
  read_file: { glyph: FILE_GLYPH, summariseArgs: ['path', 'offset', 'limit', 'head', 'tail'] },
  read_multiple_files: { glyph: FILE_GLYPH, summariseArgs: ['paths'] },
  gth_read_binary: { glyph: FILE_GLYPH, summariseArgs: ['path'] },
  write_file: { glyph: FILE_GLYPH, summariseArgs: ['path'], formatBody: formatWriteFileBody },
  edit_file: {
    glyph: FILE_GLYPH,
    summariseArgs: ['path', 'dryRun'],
    formatBody: formatEditFileBody,
  },
  create_directory: { glyph: FILE_GLYPH },
  list_directory: { glyph: FILE_GLYPH },
  list_directory_with_sizes: { glyph: FILE_GLYPH },
  directory_tree: { glyph: FILE_GLYPH },
  move_file: { glyph: FILE_GLYPH },
  search_files: { glyph: FILE_GLYPH },
  get_file_info: { glyph: FILE_GLYPH },
  delete_file: { glyph: FILE_GLYPH },
  delete_directory: { glyph: FILE_GLYPH },
  list_allowed_directories: { glyph: FILE_GLYPH },
  run_shell_command: {
    glyph: SHELL_GLYPH,
    summariseArgs: ['command'],
    formatBody: formatShellBody,
    shellShaped: true,
  },
  run_tests: { glyph: SHELL_GLYPH, formatBody: formatShellBody, shellShaped: true },
  run_single_test: {
    glyph: SHELL_GLYPH,
    summariseArgs: ['testPath'],
    formatBody: formatShellBody,
    shellShaped: true,
  },
  run_lint: { glyph: SHELL_GLYPH, formatBody: formatShellBody, shellShaped: true },
  run_build: { glyph: SHELL_GLYPH, formatBody: formatShellBody, shellShaped: true },
  task: { glyph: '🤖', summariseArgs: ['subagent_type', 'description'] },
};

/** The registry glyph for a tool name (generic `⚙` when unknown). */
export function getToolGlyph(name: string): string {
  return TOOL_DISPLAY_REGISTRY[name]?.glyph ?? FALLBACK_GLYPH;
}

/* ------------------------------------------------------------------------- *
 * Params summary                                                             *
 * ------------------------------------------------------------------------- */

/**
 * One-line call summary: `name(arg=val, other=…)`. Key args only (per the registry entry, or
 * all args for unknown tools), each value inlined + truncated, the whole parenthesised part
 * capped at {@link TOOL_SUMMARY_MAX_CHARS}, and everything secret-redacted (literals +
 * provider patterns). Unparsable (mid-stream/malformed) args render as `name(…)` — never a
 * raw JSON dump. `secrets` defaults to the env-derived literals; pass explicitly for tests.
 *
 * Redaction runs BEFORE every truncation step (per value in {@link formatParamValue}, and again
 * before the whole-summary cap): truncating first would bisect a literal secret longer than a
 * cap so it no longer literal-matches, leaking its head into the rendered summary
 * (fix-cycle-1 finding). The final pass over the assembled string is defense in depth only —
 * `redactText` is idempotent, so re-redacting already-marked text is safe.
 */
export function summariseToolCall(
  name: string,
  argsText: string | undefined,
  secrets: readonly string[] = getDefaultSecrets()
): string {
  const label = name || '(tool)';
  const args = parseToolArgsSafe(argsText);
  if (args === null) {
    const hasRawArgs = !!argsText && argsText.trim().length > 0 && argsText.trim() !== '{}';
    return hasRawArgs ? `${label}(${ELLIPSIS})` : `${label}()`;
  }
  const entry = TOOL_DISPLAY_REGISTRY[name];
  const keys =
    entry?.summariseArgs !== undefined
      ? entry.summariseArgs.filter((k) => args[k] !== undefined)
      : Object.keys(args);
  const parts = keys.map((k) => `${k}=${formatParamValue(args[k], secrets)}`);
  // Anything parsed but not summarised (write_file's content, unlisted keys) is signalled with
  // a trailing ellipsis so the summary never silently pretends to be the whole call.
  const hasHiddenArgs =
    entry?.summariseArgs !== undefined && Object.keys(args).some((k) => !keys.includes(k));
  if (hasHiddenArgs) parts.push(ELLIPSIS);
  // Redact before the whole-summary cap too, so this truncation can no more bisect a secret
  // out of literal-matching than the per-value one can.
  const inner = truncate(redactText(parts.join(', '), secrets), TOOL_SUMMARY_MAX_CHARS);
  return redactText(`${label}(${inner})`, secrets);
}

/* ------------------------------------------------------------------------- *
 * Body + preview                                                             *
 * ------------------------------------------------------------------------- */

/**
 * The FULL (uncapped) body lines for a call: the registry formatter when one applies, else the
 * shape-based shell formatter, else the generic fallback (live output lines, then the final
 * result — both dim). Every line is secret-redacted. Used by the TUI's EXPANDED panel; cap it
 * with {@link capToolDisplayLines} for the collapsed preview.
 */
export function buildToolBodyLines(
  input: ToolCallDisplayInput,
  secrets: readonly string[] = getDefaultSecrets()
): ToolDisplayLine[] {
  const args = parseToolArgsSafe(input.argsText);
  const entry = TOOL_DISPLAY_REGISTRY[input.name];
  let lines = entry?.formatBody?.(input, args) ?? null;
  // TUI-C32 residual c — only fall back to the shape-based shell formatter for names that may be
  // shell-shaped (flagged registry entries + unregistered custom tools), so a registered non-shell
  // tool whose result merely contains `<COMMAND_OUTPUT>` is rendered generically, not shell-parsed.
  if (lines === null && nameAllowsShellShape(input.name)) lines = formatShellBody(input);
  if (lines === null) {
    lines = [];
    if (input.output && input.output.trim().length > 0 && !input.liveOutputAlreadyShown) {
      lines.push(...styled(toLines(input.output), 'dim'));
    }
    if (input.result && input.result.trim().length > 0) {
      lines.push(...styled(toLines(input.result), 'dim'));
    }
  }
  return lines.map((l) => ({ ...l, text: redactText(l.text, secrets) }));
}

/**
 * Apply the canonical render cap: at most `maxLines` lines (each char-capped at
 * {@link TOOL_PREVIEW_LINE_MAX_CHARS} with `…`), plus a dim `… (+N more lines)` overflow
 * marker when anything was cut. The marker line is IN ADDITION to the cap so exactly how much
 * was hidden is always stated (DL-4 transparency).
 */
export function capToolDisplayLines(
  lines: ToolDisplayLine[],
  maxLines: number = TOOL_OUTPUT_PREVIEW_LINES
): ToolDisplayLine[] {
  const capped = lines.slice(0, maxLines).map((l) => ({
    ...l,
    text: truncate(l.text, TOOL_PREVIEW_LINE_MAX_CHARS),
  }));
  const hidden = lines.length - capped.length;
  if (hidden > 0) {
    capped.push({
      text: `${ELLIPSIS} (+${hidden} more line${hidden === 1 ? '' : 's'})`,
      style: 'dim',
    });
  }
  return capped;
}

/**
 * The collapsed inline preview: {@link buildToolBodyLines} capped at the canonical
 * {@link TOOL_OUTPUT_PREVIEW_LINES}.
 */
export function buildToolPreviewLines(
  input: ToolCallDisplayInput,
  secrets: readonly string[] = getDefaultSecrets()
): ToolDisplayLine[] {
  return capToolDisplayLines(buildToolBodyLines(input, secrets));
}

/* ------------------------------------------------------------------------- *
 * ANSI adapter (plain surface)                                               *
 * ------------------------------------------------------------------------- */

const ANSI_BY_STYLE: Record<ToolDisplayStyle, string> = {
  dim: '\x1b[2m',
  added: '\x1b[32m',
  removed: '\x1b[31m',
};
const ANSI_RESET = '\x1b[0m';

/**
 * Render one styled line as a raw string for the plain surface. Each line is SELF-STYLED
 * (its own SGR open + reset) so lines compose safely regardless of surrounding styling.
 * With `colour` false the raw text is returned unchanged — the clean monochrome degradation
 * for non-TTY/piped output (DL-7); diff lines still read via their `+`/`-` prefixes.
 */
export function renderToolLineAnsi(line: ToolDisplayLine, colour: boolean): string {
  if (!colour) return line.text;
  return `${ANSI_BY_STYLE[line.style]}${line.text}${ANSI_RESET}`;
}
