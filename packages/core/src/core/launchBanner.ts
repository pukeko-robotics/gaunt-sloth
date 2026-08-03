/**
 * @module launchBanner
 * TUI-C33 — the welcoming ASCII-art launch banner shown at the top of an INTERACTIVE session
 * (`gth chat` / `gth code`): a sloth face on the left, the `GAUNT SLOTH` wordmark plus three live
 * fields (version, model/provider, working directory) on the right.
 *
 *
 *      ▄█▀▀▀▀▀▀▀▀█▄       ┏┓         ┏┓┓   ┓
 *    ▄▀█▄█▀▀▀▀▀▀█▄█▀▄     ┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓   v2.0.0-alpha.25
 *    █  ▀█▄▀  ▀▄█▀  █     ┗┛┗┻┗┻┛┗┗  ┗┛┗┗┛┗┛┗
 *    ▀▄▀▀ ██████ ▀▀▄▀     gemini-3.1-pro (google-genai)
 *      ▀██████████▀       ~/dev/takahe
 *
 * It is deliberately NOT emitted by the one-shot verbs (`ask`, `review`, `pr`, `get`, `eval`,
 * `batch`, `api`, `init`): their stdout is piped into files, diffs and CI, where a banner is
 * corruption rather than welcome.
 *
 * ## Why this module is pure, and split in two halves
 *
 * The banner has to render IDENTICALLY on two surfaces that share no rendering code — the Ink TUI
 * (`packages/app/src/tui/components/LaunchBanner.tsx`) and the plain `--no-tui` readline session
 * (`packages/agent/src/modules/interactiveSessionModule.ts`). So all the geometry lives here as
 * pure functions of `{ version, model, provider, directory, homeDir, columns, colour }`
 * ({@link launchBannerRows} / {@link launchBannerText}), and the surfaces differ only in how they
 * EMIT: one string through `displayLaunchBanner`, or one `<Text>` per row. That is the same split
 * `Rule.tsx` uses (pure `ruleWidth` + a thin React component), including its
 * `columns === undefined → 80` convention for a non-TTY / test stdout.
 *
 * The one impure function is {@link launchBannerFields} at the bottom, which reads the live
 * version / project dir / home dir. It is shared for the same reason: both surfaces must read the
 * same sources rather than each inventing its own.
 *
 * ## Why the right column is a slice at a fixed column, not a glyph classifier
 *
 * Colouring is "columns 0–20 are magenta, columns 21+ are default foreground" — a per-line split at
 * {@link RIGHT_COLUMN}. It is emphatically NOT "is this character a block element": the wordmark is
 * box-drawing, the face is block elements, and the moment a field value contained a `▀` (or the art
 * gained a non-block glyph) a classifier would mis-colour it. A fixed column cannot.
 *
 * The face is 16 columns wide and the right column starts at {@link RIGHT_COLUMN}, leaving a
 * 5-column gutter. The version label sits three columns after the widest wordmark line, i.e. at
 * {@link VERSION_COLUMN}.
 *
 * ## Why the padding is part of the layout rather than of either surface
 *
 * TUI-C36 — the block is a splash, so it gets breathing room: one blank row above, one blank row
 * below, and a {@link LEFT_PAD}-column left margin on every art row. That padding lives HERE, with
 * the rest of the geometry, for the same reason the columns do — the Ink surface and the readline
 * surface must show the same block, and a margin added by one renderer is a margin the other one
 * lacks. The blank rows are genuinely empty (no pad, no escape): a padding row that carried
 * trailing spaces would be visible the moment anything selected or copied it.
 *
 * The pad column shifts every column constant by exactly one, which is why they are all derived
 * from {@link LEFT_PAD} rather than written as literals. The field budgets are expressed against
 * those constants (`columns - RIGHT_COLUMN`), so they absorb the shift without changing.
 *
 * ## Why every dynamic field is bounded, and why the version is the one that is DROPPED
 *
 * A wrapped line SHATTERS the art: the continuation starts back at column 0 and collides with the
 * face, so the sloth grows an extra row of model id. Wrapping is therefore not allowed to happen at
 * all, and each field is bounded by what is left of the terminal on its own line — `columns - 21`
 * for the model/provider and directory lines, `columns - 43` for the version.
 *
 * Those budgets are TERMINAL COLUMNS, and every measurement and cut in this module goes through
 * `#src/utils/displayWidth.js` for that reason. A CJK ideograph or an emoji is one code point in
 * two columns, so a `.length`-style count would let a path or model id containing either measure
 * short, slip past its budget and wrap — the very failure above.
 *
 * The model/provider and directory lines TRUNCATE to that budget: a clipped model id or path is
 * still honest, it visibly ends in `…`. The directory is truncated from the LEFT
 * (`…/dev/takahe`), because the leaf directory is the informative end; the model keeps its head and
 * loses its tail.
 *
 * A VERSION that does not fit is dropped entirely instead ({@link fitOrDrop}) — never truncated.
 * A clipped version number is not merely less informative, it is MISLEADING: `v2.0…` reads as a
 * real, different version (2.0.1, say) rather than as a clipped `2.0.0-alpha.25`, and a wrong
 * version in a bug report costs more than an absent one. The model/provider line already sets that
 * drop-rather-than-mislead precedent by omitting itself when nothing resolves.
 *
 * Below {@link MIN_BANNER_COLUMNS} the right column cannot fit at all, so the face prints alone
 * rather than wrapping the wordmark into rubble.
 */
import { homedir } from 'node:os';
import { ELLIPSIS, ELLIPSIS_WIDTH } from '#src/core/toolDisplay.js';
import { ANSI_COLORS } from '#src/utils/consoleUtils.js';
import { displayWidth, sliceEndToWidth, sliceToWidth } from '#src/utils/displayWidth.js';
import { getProjectDir, getSlothVersion } from '#src/utils/systemUtils.js';

/**
 * The sloth face, columns 0–15. Lines 1 and 5 are 14 columns, lines 2–4 are 16 — the face field is
 * 16 wide and the short lines simply do not reach the edge. Do not "tidy" the leading spaces: they
 * are part of the art.
 */
const FACE_LINES = [
  '  ▄█▀▀▀▀▀▀▀▀█▄',
  '▄▀█▄█▀▀▀▀▀▀█▄█▀▄',
  '█  ▀█▄▀  ▀▄█▀  █',
  '▀▄▀▀ ██████ ▀▀▄▀',
  '  ▀██████████▀',
] as const;

/**
 * TUI-C40 — the resting face, under the name the animation layer refers to it by.
 *
 * Every frame below is the same five lines and the same 16-column field, so swapping one in changes
 * nothing about the layout: the right column still starts at {@link RIGHT_COLUMN} and the
 * truncation budgets are untouched. That invariant is what makes an animation a data change rather
 * than a geometry change, and it is asserted per frame in the specs.
 */
export const RESTING_FACE = FACE_LINES;

/**
 * The extra faces, authored in takahē (`websites/ascii-art.md`) and transcribed here so the art has
 * one home in this repo, exactly as the resting frame does. Names match the source file's blocks.
 */
const BLINK_HALF = [
  '  ▄█▀▀▀▀▀▀▀██▄',
  '▄▀█▄█▀▀▀▀▀▀███▀▄',
  '█  ▀█▄▀  ▀▄█▀  █',
  '▀▄▀▀▀▐████▌▀▀▀▄▀',
  '  ▀██████████▀',
] as const;

const BLINK_SHUT = [
  '  ▄█▀▀▀▀▀▀███▄',
  '▄▀█▄█▀▀▀▀▀▀███▀▄',
  '█  ▀█▄▀  ▀▄█▀  █',
  '▀▄▀▀▀▐████▌   ▄▀',
  '  ▀██████████▀',
] as const;

const NOD_DOWN = [
  '  ▄██████████▄',
  '▄██▀▄▄▄▄▄▄▄▄▀██▄',
  '█ ▀██ ▄  ▄ ██▀ █',
  '█ ▄▄▀█▄▄▄▄█▀▄▄ █',
  '  ▄▄▄██████▄▄▄',
] as const;

const LOOK_LEFT = [
  '  ▄██████████▄',
  '▄██▀▄▄▄▄▄▄▄████▄',
  '█ ▀██ ▄  ▄ ██▀ █',
  '█  ▄▀█▄▄▄▄█▀ ▄ █',
  '  ▄▄▄██████▄▄▄',
] as const;

const LOOK_RIGHT = [
  '  ▄██████████▄',
  '▄████▄▄▄▄▄▄▄▀██▄',
  '█ ▀██ ▄  ▄ ██▀ █',
  '█ ▄ ▀█▄▄▄▄█▀▄  █',
  '  ▄▄▄██████▄▄▄',
] as const;

const EYEROLL = [
  '  ▄█▀▀▀▀▀▀▀▀█▄',
  '▄▀█▄█▀▀▀▀▀▀█▄█▀▄',
  '█ ▀██▄▀  ▀▄██▀ █',
  '▀▌ ▄ ▐████▌ ▄ ▐▀',
  '  ▀██████████▀',
] as const;

/** The animations a click can play. This list is the complete set. */
export const SLOTH_ANIMATIONS = ['blink', 'nod', 'look-around', 'eyeroll'] as const;

export type SlothAnimation = (typeof SLOTH_ANIMATIONS)[number];

/** One frame of an animation and how long it stays on screen. */
export interface SlothAnimationStep {
  face: readonly string[];
  holdMs: number;
}

/**
 * The four sequences, as the frames shown AFTER the resting face.
 *
 * Playback always settles back on {@link RESTING_FACE} once the last step's hold elapses, so no
 * sequence lists a trailing rest — but `nod` lists rest in the MIDDLE, because nodding twice means
 * returning to level between the two dips. None of them loops, and a click plays exactly one.
 */
export const SLOTH_ANIMATION_STEPS: Record<SlothAnimation, readonly SlothAnimationStep[]> = {
  // Quick, because a blink that lingers reads as a squint.
  blink: [
    { face: BLINK_HALF, holdMs: 90 },
    { face: BLINK_SHUT, holdMs: 110 },
  ],
  nod: [
    { face: NOD_DOWN, holdMs: 160 },
    { face: RESTING_FACE, holdMs: 130 },
    { face: NOD_DOWN, holdMs: 160 },
  ],
  'look-around': [
    { face: LOOK_LEFT, holdMs: 190 },
    { face: LOOK_RIGHT, holdMs: 230 },
  ],
  // The longest hold: the joke only lands if you get to see it.
  eyeroll: [{ face: EYEROLL, holdMs: 300 }],
};

/**
 * Pick one animation at random. `random` is injectable so a test can pin the choice — the
 * production call passes nothing and gets `Math.random`.
 */
export function pickSlothAnimation(random: () => number = Math.random): SlothAnimation {
  const index = Math.floor(random() * SLOTH_ANIMATIONS.length);
  // Guard the boundary: a `random()` of exactly 1 (or a stub returning it) would index past the end.
  return SLOTH_ANIMATIONS[Math.min(index, SLOTH_ANIMATIONS.length - 1)];
}

/** The `GAUNT SLOTH` wordmark, occupying rows 1–3 of the right column. */
const WORDMARK_LINES = [
  '┏┓         ┏┓┓   ┓',
  '┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓',
  '┗┛┗┻┗┻┛┗┗  ┗┛┗┗┛┗┛┗',
] as const;

/** Widest wordmark line (19); rows 1 and 3 are padded to it so the version label lands square. */
const WORDMARK_WIDTH = Math.max(...WORDMARK_LINES.map((line) => displayWidth(line)));

/** Blank columns between the wordmark and the version label. */
const VERSION_GAP = 3;

/**
 * Blank columns prepended to every art row (TUI-C36). One column of left margin, so the block does
 * not sit flush against the edge of the terminal.
 */
export const LEFT_PAD = 1;

/** The prepended margin itself, applied to art rows only — never to the blank padding rows. */
const PAD = ' '.repeat(LEFT_PAD);

/** Columns the face field occupies, after the margin. */
const FACE_WIDTH = 16;

/** Blank columns between the face field and the right column. */
const FACE_GAP = 5;

/**
 * Column at which the right-hand column begins on EVERY row — the single number the whole layout
 * and the colour split are expressed in terms of (margin + face + gutter = 22).
 */
export const RIGHT_COLUMN = LEFT_PAD + FACE_WIDTH + FACE_GAP;

/** Column at which the version label begins on row 2 (right column + wordmark + gap = 44). */
export const VERSION_COLUMN = RIGHT_COLUMN + WORDMARK_WIDTH + VERSION_GAP;

/**
 * Field budget the narrowest banner still affords the right column — the widest wordmark line plus
 * a few columns of field, which is what the original threshold of 45 amounted to at
 * {@link RIGHT_COLUMN} 21.
 */
const MIN_FIELD_BUDGET = 24;

/**
 * Narrowest terminal that still gets the right column. The wordmark itself ends at column 40, so
 * anything narrower than this leaves no usable room for the fields beside it; below the threshold
 * the face prints alone (see the module docs on why wrapping is not an option).
 */
export const MIN_BANNER_COLUMNS = RIGHT_COLUMN + MIN_FIELD_BUDGET;

/** Width assumed when the terminal width is unknown (non-TTY / tests) — as in `ruleWidth`. */
const DEFAULT_COLUMNS = 80;

/** The live values the banner reports, plus the terminal geometry it has to fit inside. */
export interface LaunchBannerInput {
  /** Gaunt Sloth version, WITHOUT the `v` prefix (this module adds it). */
  version?: string;
  /** `config.modelDisplayName`. */
  model?: string;
  /** `config.modelProviderType`. */
  provider?: string;
  /** Working directory to report (`getProjectDir()`), before the home-prefix collapse. */
  directory?: string;
  /** The user's home dir; when `directory` sits under it the prefix collapses to `~`. */
  homeDir?: string;
  /** Live `stdout.columns`; `undefined` (non-TTY / tests) falls back to {@link DEFAULT_COLUMNS}. */
  columns?: number;
  /** Emit ANSI colour. Only {@link launchBannerText} reads this; Ink colours rows itself. */
  colour?: boolean;
  /**
   * TUI-C40 — which face to draw. Defaults to {@link RESTING_FACE}, so every existing caller is
   * unaffected and a plain launch is byte-identical to before. An animation frame differs only in
   * these five lines: the geometry below reads the face's width from the constants, never from the
   * strings, so a swapped frame cannot move the right column or change a truncation budget.
   */
  face?: readonly string[];
}

/**
 * One rendered banner row, pre-split at {@link RIGHT_COLUMN} so each surface can colour the two
 * halves independently without re-deriving the geometry.
 */
export interface LaunchBannerRow {
  /**
   * Columns 0–21: the {@link LEFT_PAD} margin and the face, right-padded to {@link RIGHT_COLUMN}
   * when this row has right-hand content (and left unpadded when it does not, so no row ends in
   * trailing whitespace). Rendered in magenta — the margin is blank, so painting it is a no-op.
   * Empty on the two blank padding rows, which carry nothing at all.
   */
  face: string;
  /** Columns 21+: wordmark, version, model/provider or directory. Default foreground, no colour. */
  right: string;
}

/** Resolve the usable terminal width, mirroring `ruleWidth`'s unknown/non-finite handling. */
function resolveColumns(columns: number | undefined): number {
  const cols = typeof columns === 'number' && Number.isFinite(columns) ? columns : DEFAULT_COLUMNS;
  return Math.floor(cols);
}

/**
 * Truncate `text` to `budget` columns, losing the TAIL (`gemini-3.1-pro-experi…`). Returns
 * `undefined` only when there is no budget at all; that guard keeps the function total (at
 * `budget === 0` the slice below would otherwise return a bare marker) and is not reachable from
 * {@link launchBannerRows}, whose narrowest field budget is `46 - 22 = 24`.
 *
 * `budget` is TERMINAL COLUMNS, and so is every measurement here: measuring and slicing both go
 * through the shared width primitive, which counts a CJK ideograph or an emoji as the two columns
 * it draws and cuts only between whole grapheme clusters. A code-point count would let such a
 * value measure short, escape its budget and wrap into the face; a code-point slice would cut a
 * cluster in half.
 */
function truncateTail(text: string, budget: number): string | undefined {
  if (budget <= 0) return undefined;
  if (displayWidth(text) <= budget) return text;
  return sliceToWidth(text, budget - ELLIPSIS_WIDTH) + ELLIPSIS;
}

/**
 * Truncate `text` to `budget` columns, losing the HEAD (`…/dev/takahe`). Used for the directory,
 * where the leaf is what the user needs and the ancestors are noise. Columns, not code points —
 * see {@link truncateTail}.
 */
function truncateHead(text: string, budget: number): string | undefined {
  if (budget <= 0) return undefined;
  if (displayWidth(text) <= budget) return text;
  return ELLIPSIS + sliceEndToWidth(text, budget - ELLIPSIS_WIDTH);
}

/**
 * All-or-nothing: `text` if it fits `budget` columns in full, otherwise `undefined`. Used for the
 * VERSION label, which must never be truncated — see the module docs on why a clipped version
 * number is misleading rather than merely terse. "Fits" is measured in columns, so a wide glyph
 * cannot buy its way in on a short code-point count and push the row past the terminal.
 */
function fitOrDrop(text: string, budget: number): string | undefined {
  return displayWidth(text) <= budget ? text : undefined;
}

/**
 * Collapse the home-directory prefix to `~`, the way a shell prompt does — a deep path spends its
 * whole budget on `/Users/<name>` otherwise.
 *
 * Both separators are accepted deliberately: on Windows `homedir()` reads `%USERPROFILE%` and the
 * path arrives back-slashed, and hard-coding POSIX `/` here is exactly the win32-only bug this repo
 * keeps re-learning. The boundary check matters too — `/home/mar` must not collapse inside
 * `/home/maria/x`.
 */
function collapseHomePrefix(directory: string, homeDir: string | undefined): string {
  if (!homeDir) return directory;
  if (directory === homeDir) return '~';
  if (!directory.startsWith(homeDir)) return directory;
  const boundary = directory.charAt(homeDir.length);
  if (boundary !== '/' && boundary !== '\\') return directory;
  return '~' + directory.slice(homeDir.length);
}

/**
 * Build the model/provider line: `model (provider)` when both resolve, the one that resolved when
 * only one does, and nothing at all when neither does — an empty `()` would look like a bug.
 */
function modelProviderLabel(model?: string, provider?: string): string | undefined {
  const m = model?.trim();
  const p = provider?.trim();
  if (m && p) return `${m} (${p})`;
  return m || p || undefined;
}

/** A padding row: no margin and no content, so it is an empty line on every surface. */
function blankRow(): LaunchBannerRow {
  return { face: '', right: '' };
}

/** Wrap the five art rows in the blank row above and below that make the block a splash. */
function withPaddingRows(art: LaunchBannerRow[]): LaunchBannerRow[] {
  return [blankRow(), ...art, blankRow()];
}

/**
 * Assemble the banner as {@link LaunchBannerRow}s: a blank row, the five art rows each pre-split at
 * {@link RIGHT_COLUMN}, and a blank row. Pure — every input arrives as an argument, so the geometry
 * is testable without a terminal, a config or a process.
 */
export function launchBannerRows(input: LaunchBannerInput): LaunchBannerRow[] {
  const columns = resolveColumns(input.columns);
  // TUI-C40 — the face is the one part a caller may swap; everything below is unchanged geometry.
  const face = input.face ?? RESTING_FACE;

  // Too narrow for the right column: the face alone, with no fields. It keeps its left margin and
  // its blank rows — the padding is what makes it a splash, and it costs one column, not the
  // gutter's five.
  if (columns < MIN_BANNER_COLUMNS) {
    return withPaddingRows(face.map((line) => ({ face: PAD + line, right: '' })));
  }

  // Every field is budgeted against ITS OWN start column, because the version starts further right
  // than the other two. The version is the only fit-or-drop field; the other two truncate.
  const fieldBudget = columns - RIGHT_COLUMN;
  const version = input.version?.trim()
    ? fitOrDrop(`v${input.version.trim()}`, columns - VERSION_COLUMN)
    : undefined;
  const model = modelProviderLabel(input.model, input.provider);
  const modelLine = model ? truncateTail(model, fieldBudget) : undefined;
  const directory = input.directory?.trim()
    ? truncateHead(collapseHomePrefix(input.directory.trim(), input.homeDir), fieldBudget)
    : undefined;

  const rightLines = [
    WORDMARK_LINES[0],
    version
      ? WORDMARK_LINES[1].padEnd(WORDMARK_WIDTH) + ' '.repeat(VERSION_GAP) + version
      : WORDMARK_LINES[1],
    WORDMARK_LINES[2],
    modelLine ?? '',
    directory ?? '',
  ];

  return withPaddingRows(
    face.map((line, index) => {
      const right = rightLines[index] ?? '';
      const padded = PAD + line;
      // Pad the face out to the split column only when something follows it, so a row whose field
      // was omitted (or truncated away) does not end in a run of spaces.
      return { face: right ? padded.padEnd(RIGHT_COLUMN) : padded, right };
    })
  );
}

/**
 * Render the banner as one multi-line string for the plain (readline) surface.
 *
 * Colour is the 16-colour `magenta` slot from {@link ANSI_COLORS} — the SAME slot the rest of the
 * CLI uses — and never a 256-colour or 24-bit escape: the 16-colour slot picks up the violet from
 * the user's own terminal theme, so the sloth looks native in both light and dark schemes. The
 * right column carries no escape at all, not even dim.
 *
 * With `colour: false` the output contains ZERO escape sequences — not one dim wrapper, not one
 * reset — so a monochrome session (`useColour: false`) stays genuinely clean. The caller decides;
 * the plain surface passes `getUseColour()`, the TUI passes nothing and lets Ink's own
 * colour-support detection make the same call.
 */
export function launchBannerText(input: LaunchBannerInput): string {
  return launchBannerRows(input)
    .map(({ face, right }) => {
      // A padding row is an empty line and nothing else: wrapping it in the colour pair would put
      // two escapes on a row that has no glyph to paint, which the colour-off guarantee and the
      // one-pair-per-row assertion both read as a bug.
      if (!face && !right) return '';
      return input.colour
        ? `${ANSI_COLORS.magenta}${face}${ANSI_COLORS.reset}${right}`
        : face + right;
    })
    .join('\n');
}

/** The process-resolved half of {@link LaunchBannerInput} — everything but the geometry. */
export type LaunchBannerFields = Pick<
  LaunchBannerInput,
  'version' | 'model' | 'provider' | 'directory' | 'homeDir'
>;

/**
 * Read the live fields off the process, so both surfaces report the same three values from the same
 * sources instead of each picking its own. `model`/`provider` come from the caller because only it
 * has the resolved config (`config.modelDisplayName` / `config.modelProviderType`); the rest are
 * process-global.
 *
 * Fail-soft, as in `debugDump`: `getSlothVersion()` reads the installed `package.json` through the
 * install dir that the CLI entry point sets, and THROWS when nothing set it (an embedded caller, a
 * unit test). A missing version drops one label — it must never stop a session from starting.
 */
export function launchBannerFields(model?: string, provider?: string): LaunchBannerFields {
  let version: string | undefined;
  try {
    version = getSlothVersion();
  } catch {
    /* no install dir (embedded/test) — the banner simply shows no version */
  }
  return { version, model, provider, directory: getProjectDir(), homeDir: homedir() };
}
