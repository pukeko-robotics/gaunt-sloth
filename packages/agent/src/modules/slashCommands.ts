/**
 * Pure, React-free slash-command layer shared by BOTH interactive surfaces (GS2-8): the Ink
 * TUI (`packages/app/src/tui/`, which re-exports this module) and the readline `--no-tui`
 * session (`interactiveSessionModule.ts` in this package). One registry, one source of truth —
 * a command added here appears in `/help` on both surfaces automatically.
 *
 * Mirrors how the TUI's `viewModel.ts` keeps its fold logic out of the components: the registry
 * and the parse/dispatch helpers here are unit-testable in isolation, and each surface is the
 * only place that turns the resulting {@link SlashCommandResult} into its own state / side
 * effects (the TUI's `<App>` clears the transcript / pushes notices / quits; the readline loop
 * prints notices and degrades TUI-only effects with a clear "needs the TUI" message).
 *
 * The registry is a plain array so later layers (e.g. extension-registered commands, EXT-5)
 * can append more entries via {@link createCommandRegistry} without this module changing.
 */

import type {
  ApprovalRefusal,
  ApprovalRefusalLift,
  ApprovalRung,
  McpAnnotationTrustChange,
  McpAnnotationTrustView,
  ResolvedApprovals,
  ToolAnnotationHint,
} from '@gaunt-sloth/core/config.js';
import {
  APPROVAL_POSTURES,
  APPROVAL_PROTECTION_DOCS_LINES,
  APPROVAL_RUNG_DESCRIPTIONS,
  APPROVAL_RUNG_LABELS,
  APPROVAL_RUNGS,
  APPROVAL_WRITE_MODIFIER_HINT,
  isRatedRung,
  TOOL_ANNOTATION_HINTS,
} from '@gaunt-sloth/core/config.js';
import type { ApprovalGrant } from '@gaunt-sloth/core/core/approvals/grants.js';
import { describeApprovalEntry } from '@gaunt-sloth/core/core/approvals/matcher.js';
import type { ConversationCompaction } from '@gaunt-sloth/core/core/compaction.js';
import { MOUSE_SELECTION_HINT } from '@gaunt-sloth/core/config/mouse.js';
import { parseResumeId } from '#src/modules/sessionResume.js';

/**
 * TUI-C63 — one advertised key binding: the keys as the user's keyboard spells them, and what
 * they do. The keys are a display string, not a parsed chord — this module never matches on it.
 */
export interface KeyBinding {
  /** e.g. `PgUp / PgDn`. Named for keyboards that lack the key where that differs (DL-5, DL-7). */
  keys: string;
  /** What the keys do, in one short phrase. */
  description: string;
}

/**
 * TUI-C63 — bindings grouped by the context they are reachable in. The bindings are modal (Esc
 * alone means three different things depending on what owns the keyboard), so a flat list of every
 * bound key would mislead; the group is what makes each line true.
 */
export interface KeyBindingGroup {
  /** The context the group's bindings apply in, e.g. `Scrolling the conversation`. */
  title: string;
  bindings: readonly KeyBinding[];
}

/** Read-only session context a command may surface (e.g. `/status`, `/model`). */
export interface SlashCommandContext {
  mode: string;
  modelDisplayName: string;
  /** Count of committed turns so far (for `/help`-style introspection if needed). */
  turnCount: number;
  /**
   * GS2-20 — the conversation this session is recording under, as `gth history list` numbers it,
   * so `/status` can name what `gth history resume <id>` would take. Undefined when nothing is
   * being recorded (history off, the store did not open, or a surface with no store at all).
   */
  conversationId?: number;
  /** Whether tool-call panels currently show their full args/result (drives `/verbose` copy). */
  toolsExpanded: boolean;
  /** Whether the docked debug panel is currently shown (drives `/debug` copy). */
  debugVisible: boolean;
  /**
   * TUI-C37 — whether terminal mouse reporting is currently on (drives `/mouse` copy). Undefined on
   * surfaces that have no mouse layer at all, where `/mouse` reports itself unavailable rather than
   * claiming a state it cannot change.
   */
  mouseEnabled?: boolean;
  /**
   * Pre-rendered, secret-free summary lines of the resolved config, surfaced read-only by
   * `/config` (GS2-1). The App builds these once from the resolved config (see
   * {@link formatConfigSummary}); omitted where no config is loaded (e.g. the fixture agent).
   */
  configSummary?: string[];
  /**
   * TUI-C19 — the actual config-validation warnings (unknown keys / deprecated names) captured at
   * load, so `/config` can render the DETAILS the standing "config has problems" advisory line
   * points at. Empty/omitted ⇒ `/config` shows only the resolved summary (a clean config).
   */
  configWarnings?: string[];
  /**
   * GS2-7 (B20) / GS2-19 — pre-rendered recent-conversation lines for `/history`. The App builds
   * these fail-soft from the local history store (see `formatConversationList`); omitted when no
   * store is available (history never enabled / DB missing), in which case `/history` shows an
   * "unavailable" notice.
   */
  historySummary?: string[];
  /**
   * GS2-7 (B20) — pre-rendered analytics lines for `/insights` (see `formatInsightsSummary`),
   * built fail-soft by the App; omitted when no store is available.
   */
  insightsSummary?: string[];
  /**
   * GS2-7 (B20) — a fail-soft search provider for `/search <query>`, bound by the App to the local
   * history store (returns already-formatted result lines). Injected (rather than the command
   * touching the DB) so the registry stays pure and testable with a stub. Omitted when no store is
   * available, in which case `/search` reports that history is unavailable.
   */
  historySearch?: (query: string) => string[];
  /**
   * TUI-C18 — the reasoning text of each committed assistant turn, in transcript order (index 0 =
   * turn 1). `''` for a turn that produced no thinking layer. Drives `/reasoning`, which reprints a
   * committed turn's thinking. The App builds this from the transcript; omitted (empty) where there
   * are no committed turns yet.
   */
  turnReasonings?: string[];
  /**
   * GS2-46 — the live transcript (all committed turns, tool calls + results) and the resolved
   * config, for `/debug-dump`. Kept opaque (`unknown`) so this pure module stays decoupled from
   * the TUI's `TranscriptItem` type and `GthConfig` — forwarded as-is into the injected
   * `dumpDebugSession` writer (see {@link DebugDumpInput}). Omitted where no session state is
   * available (e.g. the fixture agent), in which case `/debug-dump` reports itself unavailable.
   */
  transcript?: unknown[];
  /** GS2-46 — see {@link SlashCommandContext.transcript}. */
  resolvedConfig?: unknown;
  /**
   * GS2-46 — fs-writing implementation for `/debug-dump`: writes an UNSANITIZED archive
   * (transcript, resolved config, env/version info, the in-memory debugLog ring buffer, and
   * best-effort git repo state) to `~/.gsloth/debug-dumps/<timestamp>/` and returns its path.
   * Injected by the App the same way `historySearch` is (GS2-7), so this module stays pure and
   * testable with a fake — the real writer (`packages/core/src/utils/debugDump.ts`) does the
   * actual I/O. Omitted ⇒ `/debug-dump` reports itself unavailable (fixture / no session state).
   */
  dumpDebugSession?: (input: DebugDumpInput) => { archiveDir: string };
  /**
   * TUI-C63 — the key bindings THIS surface actually has, grouped by context, appended to `/help`.
   *
   * Supplied by the surface rather than held as a constant here, because this registry is shared
   * (GS2-8) and the two surfaces have different keyboards: the full-screen TUI owns its conversation
   * region and every key that scrolls it, while the readline session has no Ink components, no mouse
   * layer and the terminal's own scrollback — so wheel, PgUp/PgDn, Ctrl+Home/Ctrl+End and Ctrl+T
   * mean nothing there. Readline passes nothing and its `/help` stays the command list alone.
   * GS2-87: the divergence is deliberate and stated, never accidental.
   */
  keyBindings?: readonly KeyBindingGroup[];
}

/**
 * GS2-46 — the input `/debug-dump` assembles from context and hands to the injected
 * `dumpDebugSession` writer. `transcript`/`config` are opaque to this pure module (the real
 * writer, not this file, interprets them); `modelDisplayName` mirrors the field already on
 * {@link SlashCommandContext}.
 */
export interface DebugDumpInput {
  transcript: unknown[];
  config: unknown;
  modelDisplayName: string;
  /**
   * GS2-47 — whether the writer should redact secrets from every artifact. Resolved by
   * {@link resolveDebugDumpRedact} from the config (`debugDump.redact`, default ON) and the
   * `--unsafe-no-redact` command flag, then threaded straight through to `writeDebugDump`.
   */
  redact: boolean;
}

/**
 * The subset of the resolved config `/config` surfaces. Structurally typed (not the full
 * `GthConfig`) so this pure module stays decoupled from the config types; the caller passes the
 * real resolved config, which is a superset.
 */
export interface ConfigSummaryInput {
  modelDisplayName?: string;
  agent?: { backend?: string };
  filesystem?: unknown;
  streamOutput?: boolean;
  useColour?: boolean;
  consoleLevel?: unknown;
  commands?: Record<string, unknown>;
}

/**
 * Build the compact, read-only `/config` summary (GS2-1): a handful of the most orienting
 * resolved-config fields, one per line, with a pointer to `gth config print` for the full view.
 * Pure and secret-free — it only reads non-sensitive scalar fields (never API keys / the live
 * llm instance). Used by the App to fill {@link SlashCommandContext.configSummary}.
 *
 * CFG-25 — `filesystem` is a precedence-picked per-command field (GS2-60), so the panel prints the
 * EFFECTIVE value for the running `command`, read from `config.commands[command].filesystem` —
 * where the GS2-60 resolution already baked the correct 4-layer precedence — falling back to the
 * top-level value, exactly the read `getEffectiveConfig` performs (no precedence re-derived here).
 * When the effective and top-level values differ, both are shown
 * (`Filesystem: all (code; top-level: none)`) so the top-level default can never understate what
 * the session can actually do. Of the other precedence-picked fields
 * (`builtInTools`/`allowedTools`/`binaryFormats`), none are printed by this panel, so none can
 * misreport the same way.
 */
export function formatConfigSummary(config: ConfigSummaryInput, command?: string): string[] {
  const fmt = (v: unknown): string =>
    typeof v === 'string' ? v : Array.isArray(v) ? JSON.stringify(v) : String(v);
  const lines: string[] = [];
  lines.push(`Model: ${config.modelDisplayName || 'unknown'}`);
  lines.push(`Agent backend: ${config.agent?.backend ?? 'lean'}`);
  const commandFilesystem = command
    ? (config.commands?.[command] as { filesystem?: unknown } | undefined)?.filesystem
    : undefined;
  const effectiveFilesystem =
    commandFilesystem !== undefined ? commandFilesystem : config.filesystem;
  if (effectiveFilesystem !== undefined) {
    const differs =
      commandFilesystem !== undefined &&
      config.filesystem !== undefined &&
      fmt(commandFilesystem) !== fmt(config.filesystem);
    lines.push(
      differs
        ? `Filesystem: ${fmt(commandFilesystem)} (${command}; top-level: ${fmt(config.filesystem)})`
        : `Filesystem: ${fmt(effectiveFilesystem)}`
    );
  }
  if (config.streamOutput !== undefined) lines.push(`Stream output: ${config.streamOutput}`);
  if (config.useColour !== undefined) lines.push(`Colour: ${config.useColour}`);
  const commandNames = config.commands ? Object.keys(config.commands) : [];
  if (commandNames.length > 0) lines.push(`Commands configured: ${commandNames.join(', ')}`);
  lines.push('Run `gth config print` for the full resolved config (secrets redacted).');
  return lines;
}

/**
 * The `/config` notice, from the pre-rendered summary lines (or an unavailable fallback).
 *
 * TUI-C19 — when config-validation `warnings` are present (unknown keys / deprecated names), they
 * are rendered FIRST, as the details the standing "config has problems" advisory line points at,
 * then a blank spacer, then the resolved summary. A clean config (no warnings) reads exactly as
 * before. Tone flips to `warn` (yellow) while there are warnings so the block reads as caution.
 */
export function configNotice(
  summary: string[] | undefined,
  warnings?: string[]
): SlashCommandNotice {
  const summaryLines =
    summary && summary.length > 0
      ? summary
      : ['Configuration details are not available in this session.'];
  const hasWarnings = !!warnings && warnings.length > 0;
  const lines = hasWarnings
    ? [
        `${warnings.length === 1 ? 'Config warning' : `Config warnings (${warnings.length})`}:`,
        ...warnings.map((w) => `  • ${w}`),
        '',
        ...summaryLines,
      ]
    : summaryLines;
  return {
    title: 'Resolved configuration',
    lines,
    ...(hasWarnings ? { tone: 'warn' as const } : {}),
  };
}

/** Shared "history is unavailable" body (history off / DB missing), reused by all three commands. */
const HISTORY_UNAVAILABLE_LINES = [
  'No local session history is available in this session.',
  'Recording is on by default (local only); `history.enabled: false` in your gsloth config turns ' +
    'it off.',
];

/** The `/history` notice (GS2-7): recent recorded sessions, or an "unavailable" fallback. */
export function historyNotice(summary: string[] | undefined): SlashCommandNotice {
  return {
    title: 'Recent sessions',
    lines: summary && summary.length > 0 ? summary : HISTORY_UNAVAILABLE_LINES,
  };
}

/** The `/insights` notice (GS2-7): local analytics summary, or an "unavailable" fallback. */
export function insightsNotice(summary: string[] | undefined): SlashCommandNotice {
  return {
    title: 'Session insights (local only)',
    lines: summary && summary.length > 0 ? summary : HISTORY_UNAVAILABLE_LINES,
  };
}

/**
 * The `/search` notice (GS2-7). With no query it prints usage; otherwise it runs the injected
 * fail-soft {@link SlashCommandContext.historySearch} provider and renders its result lines. When
 * no provider is bound (no store), it reports history as unavailable.
 */
export function searchNotice(
  args: string[],
  search: ((query: string) => string[]) | undefined
): SlashCommandNotice {
  const query = args.join(' ').trim();
  if (!query) {
    return {
      title: 'Search session history',
      lines: ['Usage: /search <terms> — full-text search across your recorded sessions.'],
    };
  }
  if (!search) {
    return { title: `Search: "${query}"`, lines: HISTORY_UNAVAILABLE_LINES };
  }
  return { title: `Search: "${query}"`, lines: search(query) };
}

/**
 * A structured, noticeable command-feedback block (TUI-C14): a title that states WHAT happened
 * plus body lines explaining HOW it affects the user. The component renders these via
 * `<CommandNotice>` so every command gives consistent, explanatory feedback.
 */
export interface SlashCommandNotice {
  title: string;
  lines: string[];
  /** Title tone; defaults to 'info' (cyan). Use 'warn' (yellow) for unknown commands. */
  tone?: 'info' | 'warn';
}

/**
 * The effects a dispatched command can request. The component interprets these; the command
 * itself stays pure (no React, no I/O) so it is trivially testable.
 */
export interface SlashCommandResult {
  /**
   * A structured notice to commit into the transcript (the command's user-visible feedback).
   * Preferred over `message` for all commands so feedback is consistent and noticeable (TUI-C14).
   */
  notice?: SlashCommandNotice;
  /** A terse system line (incidental/error output); commands prefer `notice`. */
  message?: string;
  /** Level for the system line; defaults to 'info'. */
  level?: string;
  /** When true, the component clears the transcript. */
  clearTranscript?: boolean;
  /** When true, the component toggles the docked debug panel (the debug views). */
  toggleDebug?: boolean;
  /** When true, the component toggles tool-call panels between collapsed and expanded. */
  toggleTools?: boolean;
  /**
   * TUI-C37 — the state `/mouse` asks the surface to move terminal mouse reporting to. The command
   * stays pure (it cannot write escape sequences), so the App applies it and owns the actual
   * enable/disable, the same division `/approvals` uses for the runner's posture.
   */
  setMouse?: boolean;
  /**
   * CFG-27 — a requested action from `/approvals`. `{ show: true }` asks the surface to DISPLAY
   * the current posture; `{ rung }` asks it to switch the session to that rung. The command itself
   * stays pure — it cannot read the runner's posture — so the surface owns the apply + the
   * resulting-state notice (mirroring how `/verbose` / `/debug` defer their state-aware copy to
   * the App).
   *
   * There is deliberately NO `toggle` action: with five ordered rungs a flip has no honest
   * meaning, which is also why `/auto-approve` and `/bypass-approve` were retired with the
   * three-mode vocabulary that gave them their names.
   *
   * EXT-70 adds `{ trust }` — start or stop believing specific annotation hints from one MCP
   * server (§4.7.1). It takes the same route for the same reason: the command cannot read or write
   * the runner's posture, so it states the request and the surface applies it and reports what
   * landed.
   */
  approvals?:
    | { show: true }
    | { rung: ApprovalRung }
    | { trust: McpTrustRequest }
    | { undeny: { index: number } };
  /**
   * TUI-C18 — a committed turn's thinking to REPRINT into the transcript (the `/reasoning` command).
   * Recall rather than retro-mutation: a fresh block reusing the TUI-C15 `💭`/gutter styling appears
   * at the bottom of the conversation, where the user is looking, instead of changing a turn they
   * have scrolled away from. The App turns this into a `reasoning` transcript item; the command stays
   * pure (it resolves the target from `turnReasonings`). Absent when the command instead returns a
   * friendly `notice` (no reasoning / out-of-range).
   */
  reprintReasoning?: { reasoning: string; turnNumber: number };
  /**
   * GS2-23 — a request from `/compact` to fold the older conversation into a summary in the
   * model's context. Takes the `approvals: { rung }` route for the same reason: the command cannot
   * reach the runner, so it states the request and the surface awaits
   * `runner.compactConversation` and commits {@link compactionNotice} for what LANDED. `focus` is
   * the free text after the command — what the summary should concentrate on.
   */
  compact?: { focus?: string };
  /**
   * GS2-20 — a request from `/resume` to re-enter a stored conversation. With an `id` the surface
   * resolves and applies it through the one seam in `sessionResume.ts` — the same two calls
   * `--resume <id>` makes at boot — and commits the resumed-conversation banner and the restored
   * turns, or the refusal. With no `id` the surface lists the conversations that can be resumed,
   * leaving out the one it is in. The command itself stays pure: it cannot reach the store or the
   * runner, so it states the request.
   */
  resume?: { id?: number };
  /** When true, the component quits the app (runs `onExit`). */
  exit?: boolean;
}

/** A single registered slash command. `run` is pure: context in, result out. */
export interface SlashCommand {
  /** The name without the leading slash, e.g. `help`. Matched case-insensitively. */
  name: string;
  /** One-line description shown by `/help`. */
  description: string;
  /**
   * EXT-12 — whether this command may be dispatched WHILE a turn is streaming ("during
   * inference"). Defaults to false: most commands are idle-only. The read-only / session-toggle
   * commands (e.g. `/approvals`, `/verbose`, `/debug`, `/help`, `/model`) set this so the user
   * can change the approval mode or inspect state mid-turn without interrupting the run. Commands that
   * mutate the transcript or thread (`/clear`) or end the session (`/exit`) stay idle-only.
   */
  availableDuringRun?: boolean;
  run(ctx: SlashCommandContext, args: string[]): SlashCommandResult;
}

/** Parsed shape of a `/...` line. `null` for plain (non-slash) input. */
export interface ParsedSlashCommand {
  name: string;
  args: string[];
}

/**
 * Parse a raw input line into a slash command, or `null` if it is not one. A line is a slash
 * command iff its first non-whitespace character is `/` AND no further `/` appears after the
 * leading one (GS2-8, Mari's dogfood addendum): a pasted filesystem path like
 * `/usr/home/bob/test.md` contains later slashes, so it falls through as ordinary prompt text
 * instead of being swallowed as an unknown command. The name is lower-cased; remaining
 * whitespace-separated tokens are the args.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  // The `/`-vs-path heuristic: a real command has NO further `/` after the leading one.
  if (trimmed.indexOf('/', 1) !== -1) return null;
  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null; // a bare "/" is not a command
  const [name, ...args] = tokens;
  return { name: name.toLowerCase(), args };
}

/**
 * TUI-C10 — the discovery-menu trigger test. The Ink `<PromptInput>` shows the slash-command menu
 * while the user is typing a bare command: the raw input is a menu query iff its first character is
 * `/` and it contains no whitespace yet (once a space is typed the user is entering args, so the
 * menu closes and normal dispatch takes over). Returns the lower-cased query AFTER the slash (so a
 * bare `/` yields `''` = "show everything"), or `null` when the input is not a menu trigger.
 *
 * Kept pure and next to the registry (like {@link parseSlashCommand}) so the menu's show/hide and
 * filter logic is unit-testable without React.
 *
 * GS2-8 — mirrors {@link parseSlashCommand}'s `/`-vs-path heuristic: input with a later `/`
 * (a pasted path like `/usr/bin`) is not a command, so it never triggers the menu either.
 */
export function slashMenuQuery(input: string): string | null {
  if (!/^\/\S*$/.test(input)) return null;
  if (input.indexOf('/', 1) !== -1) return null; // later `/` ⇒ a path, not a command query
  return input.slice(1).toLowerCase();
}

/**
 * TUI-C10 — filter the registry down to the commands that match a menu query, most-relevant first.
 * Prefix matches (the name starts with the query) rank above looser substring matches; within each
 * bucket the registry's own order is preserved (so extension-registered commands — appended to the
 * array — naturally sort after the built-ins). An empty query returns the whole registry, so a bare
 * `/` lists every command including any the extensions added (never a hardcoded list).
 *
 * Pure: takes the registry the caller already built via {@link createCommandRegistry}, so the menu
 * automatically reflects extension commands without this layer knowing they exist.
 */
export function filterSlashCommands(registry: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...registry];
  const prefix = registry.filter((c) => c.name.startsWith(q));
  const substring = registry.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...substring];
}

/**
 * The notice for the tool-detail toggle, given the RESULTING (post-toggle) state. Shared by the
 * `/verbose` command (GS2-8 rename of `/tools`) and the Ctrl+T key handler so the copy
 * is single-sourced (TUI-C14).
 */
export function toolsToggleNotice(expanded: boolean): SlashCommandNotice {
  return expanded
    ? {
        title: 'Tool details: on',
        lines: [
          'Tool calls now show their full inputs and results in the chat history.',
          'Applies to the whole conversation on screen — run /verbose again to collapse them.',
        ],
      }
    : {
        title: 'Tool details: off',
        lines: [
          'Tool calls now show as a single summary line in the chat history.',
          'Applies to the whole conversation on screen — run /verbose again to show the detail.',
        ],
      };
}

/**
 * The notice for the debug-panel toggle, given the RESULTING (post-toggle) state. Shared so the
 * command reports exactly the state the component will apply.
 */
export function debugToggleNotice(visible: boolean): SlashCommandNotice {
  return visible
    ? {
        title: 'Debug panel: shown',
        lines: [
          'Docked panel with the sent-to-model, tools, MCP and raw-response views.',
          'Run /debug again to hide it; Tab cycles its views.',
        ],
      }
    : {
        title: 'Debug panel: hidden',
        lines: ['The docked debug views are now closed.', 'Run /debug again to bring them back.'],
      };
}

/**
 * CFG-27 — the notice for a landed approvals RUNG, given the RESULTING (post-apply) posture.
 * Shared so every surface reports exactly the state that was applied, and so the copy can never
 * drift from what the gate actually does.
 *
 * The body of each notice is §10's description, **verbatim** — the one place the ladder is
 * explained to the user, so it must not be paraphrased per surface. §10 rule 4 also fixes the
 * label: the display spelling with spaces, never the kebab-case identifier.
 *
 * `bypass` is the only warn-toned one: it is the single rung with no gate at all. Note what is
 * NOT here — the hardline floor. §8.1 forbids advertising it: descriptions name only protections
 * the user can inspect and extend, which is the deny list.
 */
/**
 * TUI-C37 — feedback for `/mouse`, describing the state the session has LANDED on.
 *
 * The selection hint is repeated on every "on" notice rather than shown once at launch, because the
 * moment a user reaches for `/mouse` is exactly the moment they are trying to copy something and
 * finding that dragging no longer selects. Telling them there and then is the difference between a
 * fixed problem and a filed bug.
 */
export function mouseToggleNotice(enabled: boolean): SlashCommandNotice {
  return {
    title: enabled ? 'Mouse on' : 'Mouse off',
    lines: enabled
      ? [
          'Clickable parts of the interface respond to the mouse, and the wheel scrolls the conversation.',
          // Qualified rather than promised: the binding is correct, but a terminal that never sets
          // the Shift bit on a wheel report (Konsole is one) delivers a plain notch, so the page
          // never happens there. Naming a key that silently does nothing is the defect TUI-C11 had
          // to correct once already.
          'Shift and the wheel together move a page, in terminals that forward Shift with the wheel.',
          MOUSE_SELECTION_HINT,
          'Turn it off for this session with /mouse off, or always with useMouse false in your config.',
        ]
      : [
          'Mouse reporting is off; text selection and copying work exactly as your terminal normally does.',
          'Turn it back on with /mouse on.',
        ],
  };
}

/** TUI-C37 — `/mouse` on a surface with no mouse layer (the plain readline session, the fixture). */
export function mouseUnavailableNotice(): SlashCommandNotice {
  return {
    title: 'Mouse unavailable',
    lines: [
      'This session has no mouse layer, so there is nothing to turn on or off.',
      'Mouse input needs an interactive terminal running the TUI.',
    ],
    tone: 'warn',
  };
}

/**
 * TUI-C37 — parse `/mouse [on|off]`. No argument means "toggle", which is what a bare command name
 * usually means; `null` marks an argument that is neither, so the caller can say so rather than
 * guess. `resolve` needs the current state only for the toggle case.
 */
export function parseMouseArg(args: string[], current: boolean): boolean | null {
  if (args.length === 0) return !current;
  const arg = args[0].toLowerCase();
  if (arg === 'on') return true;
  if (arg === 'off') return false;
  return null;
}

export function approvalsRungNotice(approvals: ResolvedApprovals): SlashCommandNotice {
  const lines = [APPROVAL_RUNG_DESCRIPTIONS[approvals.rung]];
  if (isRatedRung(approvals.rung) && approvals.rater) {
    lines.push(`The auto-rater runs under the "${approvals.rater}" identity profile.`);
  }
  lines.push('Session-scoped only (not saved); run /approvals to see or change it.');
  // The moment a user changes posture is the moment the reasoning behind the postures is worth
  // reading, and two sentences cannot hold it.
  lines.push(...APPROVAL_PROTECTION_DOCS_LINES);
  return {
    title: `Approvals: ${APPROVAL_RUNG_LABELS[approvals.rung]}`,
    lines,
    tone: approvals.rung === 'bypass' ? 'warn' : 'info',
  };
}

/**
 * The first sentence of a mode's description, for the one-line forms (the picker rows and the usage
 * hint). Cut at the sentence boundary rather than truncated, so a row never ends mid-clause.
 *
 * **A sentence ends at `.`, `?` or `!`.** The copy this shortens is ordinary prose, and a helper
 * that knows only the period renders a question as `Really?.` and hands back BOTH sentences of
 * `Ready? Then go.` — the whole description in a row sized for one line.
 *
 * A terminator only ends the sentence when a space follows it and no dot precedes it, so an
 * ellipsis reads as the pause it is instead of three sentence boundaries.
 *
 * **A description that is already one sentence keeps its own terminator rather than gaining a
 * second.** Nothing was consumed, so it arrives already terminated and appending unconditionally
 * would render `No gate..`. Every surface showing one line of a mode's copy goes through here, so
 * this is the only place that has to know any of it.
 */
export function firstSentence(description: string): string {
  const boundary = /(?<!\.)[.?!](?=\s)/.exec(description);
  const head = boundary ? description.slice(0, boundary.index + 1) : description;
  return /[.?!]$/.test(head) ? head : `${head}.`;
}

/** CFG-39 — one selectable row of the `/approvals` picker. */
export interface ApprovalPostureChoice {
  /** The mode this row sets. */
  rung: ApprovalRung;
  /** Display spelling ({@link APPROVAL_RUNG_LABELS}) — never the config identifier (§9.1). */
  label: string;
  /** The mode's own one-line description, from {@link APPROVAL_RUNG_DESCRIPTIONS}. */
  description: string;
  /** Whether the session is on this mode right now. */
  current: boolean;
}

/**
 * CFG-39 — **the picker's rows**: the four postures, in ladder order, each carrying its own copy.
 *
 * **The strings come from {@link APPROVAL_RUNG_DESCRIPTIONS}, never from the menu.** Six surfaces
 * describe these modes; a picker that authored its own text would become the seventh and the one
 * that contradicts the rest. Whoever owns that constant owns this copy too, with no second edit.
 *
 * `write` has no row — it is a modifier of Manual rather than a fifth posture — but it stays
 * settable via `/approvals write`. When the session IS on `write`, no row is marked `current`,
 * which is correct: the caller reports the live mode from its own title rather than letting a
 * picker row claim the session is on Manual when it is not.
 */
export function approvalPostureChoices(current: ApprovalRung): ApprovalPostureChoice[] {
  return APPROVAL_POSTURES.map((rung) => ({
    rung,
    label: APPROVAL_RUNG_LABELS[rung],
    description: APPROVAL_RUNG_DESCRIPTIONS[rung],
    current: rung === current,
  }));
}

/**
 * CFG-39 — the picker as TEXT: the selectable list printed in place of the interactive rows. The
 * readline session is what prints it, and that is where every `--no-tui`, piped / non-TTY, CI or
 * missing-Ink run lands.
 *
 * **A surface with no slash-command layer renders nothing from here.** The ACP and AG-UI servers
 * have none, so `/approvals` reaches them in no form at all and this list appears on neither. Do
 * not read a server's tool-approval gate as this list arriving there: that gate asks about a single
 * pending call in the protocol's own request shape and carries no posture copy.
 *
 * The same {@link approvalPostureChoices} the TTY picker renders, so the two cannot list different
 * modes or describe them differently — the text fallback is a rendering of the picker, not a
 * second implementation of it.
 */
export function approvalPostureLines(current: ApprovalRung): string[] {
  return approvalPostureChoices(current).map(
    (choice) =>
      `${choice.current ? '●' : '○'} ${choice.label} — ${firstSentence(choice.description)}`
  );
}

/**
 * CFG-27 — the `/approvals` DISPLAY: the mode and its description, the rater profile in the two
 * rated modes, and the allow/deny list sizes. Pure: the surface reads the live posture from the
 * runner and hands it in.
 *
 * CFG-39 — it also carries the selectable list, so `/approvals` with no argument answers "which
 * mode am I on?" and "what else could I be on?" in one place on EVERY surface. On a TTY the TUI
 * renders {@link approvalPostureChoices} as an interactive picker instead; this is what everything
 * else shows.
 *
 * `always: undefined` means the persisted store has not been loaded, and is rendered `—` rather
 * than a misleading `0` — a display must not create the store in order to count it.
 */
export function approvalsStatusNotice(
  approvals: ResolvedApprovals,
  allowlist: { session: number; always: number | undefined },
  refusals: readonly ApprovalRefusal[] = [],
  grants: readonly ApprovalGrant[] = [],
  trust?: McpAnnotationTrustView,
  options: {
    /**
     * CFG-39 — set by a surface that is about to render {@link approvalPostureChoices} as an
     * interactive picker, so the same four modes are not also printed as text right above it.
     *
     * **Opt-OUT, not opt-in**, and that direction is deliberate: every surface that says nothing
     * gets the full text answer, so a new non-TTY surface cannot ship a `/approvals` that silently
     * omits the list. Only the TUI, which demonstrably renders the rows another way, turns it off.
     */
    interactive?: boolean;
  } = {}
): SlashCommandNotice {
  const rater = isRatedRung(approvals.rung)
    ? (approvals.rater ?? 'main model')
    : 'not used in this mode';
  return {
    title: `Approvals: ${APPROVAL_RUNG_LABELS[approvals.rung]}`,
    lines: [
      APPROVAL_RUNG_DESCRIPTIONS[approvals.rung],
      `Auto-rater: ${rater}`,
      // GS2-20 — a grant made at the menu lives with the CONVERSATION, not the process: it is kept
      // in the history store and comes back when the conversation is resumed.
      `Allowed: ${allowlist.session} this conversation · ${allowlist.always ?? '—'} remembered · Denied: ${refusals.length}`,
      ...describeGrants(grants),
      ...(trust ? [describeMcpTrust(trust)] : []),
      // The docs pointer rides with the mode list, and is absent for the same reason the list is
      // when a picker is coming: **it is not free to print a URL.** It cannot be shortened without
      // breaking it, so it wraps, and here it would push the head of an already-long notice off a
      // short pane — which costs the reader the mode they asked about. A surface that renders the
      // picker prints this pointer a keystroke later instead, from `approvalsRungNotice`, where the
      // user has actually chosen something.
      ...(options.interactive
        ? []
        : [
            'Choose a mode with /approvals <name>:',
            ...approvalPostureLines(approvals.rung),
            APPROVAL_WRITE_MODIFIER_HINT,
            ...APPROVAL_PROTECTION_DOCS_LINES,
          ]),
      TRUST_USAGE_LINE,
    ],
    tone: approvals.rung === 'bypass' ? 'warn' : 'info',
  };
}

/** How many grants `/approvals` lists before it summarizes the rest. */
const GRANT_DISPLAY_LIMIT = 10;

/**
 * §3/§4.7.4 — the granted lines of the `/approvals` display: **what** was granted, **when**, and
 * **under which effective annotations**.
 *
 * The annotations are the half that only a tool grant has, and the half §4.7.4 exists for: a grant
 * is an approval of a tool *as annotated*, so a user asked to believe that has to be able to see
 * what they believed. Each entry is rendered by `describeApprovalEntry` — the same one-liner the
 * escalation menu names the grant with and the withdrawal notice names it with.
 *
 * **The heading claims no scope**, because the list spans both: `getGrants` reports the persisted
 * store's `always` grants alongside this session's, and an `always` grant was made in whatever
 * session the user made it in — often not this one. Each line carries its own scope and the instant
 * it was granted, which is where that question is answered.
 */
function describeGrants(grants: readonly ApprovalGrant[]): string[] {
  if (grants.length === 0) return [];
  const shown = grants.slice(0, GRANT_DISPLAY_LIMIT).map((grant) => {
    const annotations = grant.annotations
      ? `, approved as ${TOOL_ANNOTATION_HINTS.map((hint) => `${hint}=${grant.annotations?.[hint]}`).join(' ')}`
      : '';
    return `  ${describeApprovalEntry(grant.entry)} — ${grant.scope}, granted ${grant.grantedAt}${annotations}`;
  });
  const rest = grants.length - shown.length;
  return [`Granted approvals:`, ...shown, ...(rest > 0 ? [`  …and ${rest} more.`] : [])];
}

/**
 * [[EXT-107]] — how a refusal's origin is said on screen. Three sources, three lifetimes, three
 * owners, and the words have to carry the difference: the whole point of listing refusals here is
 * that a user can tell the one that ends with this conversation from the one that will still be
 * there tomorrow in any conversation, and both from the line they wrote themselves.
 *
 * GS2-20 — the middle one is *this conversation*, not *this session*: a refusal made at the menu is
 * recorded against the conversation in the history store and comes back when the conversation is
 * resumed, so its lifetime is the conversation's. (The store's own scope name stays `session`; this
 * is the label a person reads.)
 */
const REFUSAL_ORIGIN_LABELS: Record<ApprovalRefusal['origin'], string> = {
  config: 'from your approvals.deny',
  session: 'this conversation only',
  persisted: 'saved to this project',
};

/** How many refusals `/approvals` lists before it summarizes the rest. */
const REFUSAL_DISPLAY_LIMIT = 10;

/**
 * [[EXT-107]] — **the refusals in force, as their own notice**: what is refused, which list holds
 * it, and the number that lifts it. `null` when nothing is refused, so `/approvals` says nothing
 * about refusals in the ordinary case.
 *
 * This is the escape hatch, and it is the reason a refusal may be persisted at all. A session-only
 * *always reject* cost minutes when it was a mistake; saved to a project file it costs whatever it
 * takes the user to discover a file they were never told about. So this does not count refusals, it
 * makes each one findable and undoable — which is why every line carries its origin and its number.
 *
 * **A second notice rather than more rows on the posture one, and the reason is the pane.** The
 * posture notice's head is the answer the user asked for — which mode am I on — and it already
 * fills the TUI pane the picker leaves: measured, ONE added row scrolls that head off the top. Two
 * notices each keep their own heading, and the refusal list ends up nearest the prompt, which is
 * where the thing the user is about to act on belongs.
 *
 * **The overflow is walkable rather than a dead end.** The numbering is the runner's, over a
 * deterministic order (config, then saved, then session), so lifting the last shown entry brings
 * the next one into the list. A cap that simply hid the rest would put refusals beyond reach of the
 * control that exists to reach them.
 */
export function approvalsRefusalsNotice(
  refusals: readonly ApprovalRefusal[]
): SlashCommandNotice | null {
  if (refusals.length === 0) return null;
  const shown = refusals
    .slice(0, REFUSAL_DISPLAY_LIMIT)
    .map(
      (refusal) =>
        `  ${refusal.index}. ${refusal.description} — ${REFUSAL_ORIGIN_LABELS[refusal.origin]}` +
        (refusal.recordedAt ? `, refused ${refusal.recordedAt}` : '')
    );
  const rest = refusals.length - shown.length;
  return {
    title: `Refused calls: ${refusals.length}`,
    lines: [
      ...shown,
      ...(rest > 0 ? [`  …and ${rest} more, which appear here as the ones above are lifted.`] : []),
      UNDENY_USAGE_LINE,
    ],
    tone: 'info',
  };
}

/**
 * [[EXT-107]] — the removal half of the usage copy, printed under the refusal list and in the
 * usage hint.
 *
 * It names what it cannot do as well as what it can: a configured entry is the user's own file and
 * no session command rewrites it, so a user who tries and is refused should have been told first.
 */
const UNDENY_USAGE_LINE =
  'Lift one with /approvals undeny <number> — an entry from your approvals.deny is removed by ' +
  'editing that config instead.';

/**
 * §4.7.1 — the one line saying which of each server's annotation hints this session believes.
 *
 * A server is listed even when it believes nothing, because "believes nothing" is the default and
 * the user needs to be able to tell it apart from "this server is not here at all" — the two look
 * identical when only trusted servers are listed, and the second is what a typo produces.
 */
function describeMcpTrust(trust: McpAnnotationTrustView): string {
  const parts = [
    `defaults — ${trust.defaults.length > 0 ? trust.defaults.join(' ') : 'nothing'}`,
    ...trust.servers.map(
      (entry) =>
        `${entry.server} — ${entry.trusted.length > 0 ? entry.trusted.join(' ') : 'nothing'}`
    ),
  ];
  return `MCP annotations believed: ${parts.join(' · ')}`;
}

/** The `/approvals trust` half of the usage copy, shown wherever the rung half is. */
const TRUST_USAGE_LINE =
  'Believe an MCP server’s annotation hints with /approvals trust <server> <hint…>, ' +
  'and stop believing them with /approvals untrust <server> <hint…>.';

/** EXT-70 §4.7.1 — a request to start or stop believing specific hints from one server. */
export interface McpTrustRequest {
  /** §4.7.5 — the user's own `mcpServers` config key, case-sensitive. */
  server: string;
  /** The hints this request moves, in canonical spelling. Never empty. */
  hints: ToolAnnotationHint[];
  /** `true` to believe them, `false` to stop. */
  believe: boolean;
}

/** Something wrong with a `/approvals trust` invocation that the command explains rather than guesses at. */
export type ApprovalsTrustUsageProblem =
  | { kind: 'trust-missing-server'; believe: boolean }
  | { kind: 'trust-missing-hints'; believe: boolean; server: string }
  | { kind: 'unknown-hint'; believe: boolean; token: string };

/** Something wrong with a `/approvals` subcommand that the command explains rather than guesses at. */
export type ApprovalsUsageProblem =
  | ApprovalsTrustUsageProblem
  | { kind: 'undeny-missing-number' }
  | { kind: 'undeny-bad-number'; token: string };

/** What `/approvals` resolved to, or `null` when the first argument names nothing it knows. */
export type ApprovalsAction =
  | { show: true }
  | { rung: ApprovalRung }
  | { trust: McpTrustRequest }
  | { undeny: { index: number } }
  | { usage: ApprovalsUsageProblem };

/**
 * CFG-27/EXT-70 — parse the `/approvals` argument: no arg SHOWS the current posture; any of the
 * five mode names switches to it; `trust` / `untrust` move which of a server's annotation hints are
 * believed (§4.7.1). Returns `null` for an unrecognized first argument so the command renders a
 * usage hint instead of guessing.
 *
 * **All five names are accepted, not the four the picker offers.** `write` is a modifier of
 * `manual` rather than a posture of its own, so it leaves quick access — but it stays fully
 * settable here and in config, which is the whole of what "demoted" means.
 *
 * The retired `ask` spelling is NOT accepted as an alias — 2.0 is a deliberate break, and a silent
 * alias would leave the user believing in a vocabulary the gate no longer has. It is named, with
 * both of its replacements, by the config-layer error in `RETIRED_APPROVAL_MODES`.
 *
 * **Only the subcommand token is lower-cased.** A server key is the user's own `mcpServers` key
 * (§4.7.5) and is case-sensitive, so folding it would name a different server — one that believes
 * nothing, silently, while the notice reported success. A hint is matched case-insensitively
 * against the fixed vocabulary and echoed back in its **canonical** spelling, so `readonlyhint`
 * resolves rather than vanishing, and what lands in the policy is the name the derivation reads.
 */
export function parseApprovalsArg(args: string[]): ApprovalsAction | null {
  if (args.length === 0) return { show: true };
  const verb = args[0].toLowerCase();
  const rung = APPROVAL_RUNGS.find((r) => r === verb);
  if (rung) return { rung };
  // [[EXT-107]] — lift a refusal by its number in the list `/approvals` just printed. Parsed
  // strictly: a non-integer, a zero and a negative are all explained rather than coerced, because
  // this command REMOVES a protection and a silently-coerced argument would remove a different one
  // than the user named.
  if (verb === 'undeny') {
    const token = args[1];
    if (token === undefined) return { usage: { kind: 'undeny-missing-number' } };
    const index = Number(token);
    if (!Number.isInteger(index) || index < 1) {
      return { usage: { kind: 'undeny-bad-number', token } };
    }
    return { undeny: { index } };
  }
  if (verb !== 'trust' && verb !== 'untrust') return null;

  const believe = verb === 'trust';
  const server = args[1];
  if (!server) return { usage: { kind: 'trust-missing-server', believe } };
  const tokens = args.slice(2);
  if (tokens.length === 0) return { usage: { kind: 'trust-missing-hints', believe, server } };

  const hints: ToolAnnotationHint[] = [];
  for (const token of tokens) {
    const hint = TOOL_ANNOTATION_HINTS.find((h) => h.toLowerCase() === token.toLowerCase());
    if (!hint) return { usage: { kind: 'unknown-hint', believe, token } };
    if (!hints.includes(hint)) hints.push(hint);
  }
  return { trust: { server, hints, believe } };
}

/** The verb a notice names an invocation by, so copy never has to branch twice on the same flag. */
const trustVerb = (believe: boolean): string => (believe ? 'trust' : 'untrust');

/**
 * EXT-70 §4.7.1 — usage copy for a `/approvals trust` invocation that named no server, no hint, or
 * a hint that is not one of the four. Each says what is missing and shows the vocabulary, because
 * the hint names are camelCase MCP identifiers nobody guesses.
 */
export function approvalsTrustUsageNotice(problem: ApprovalsTrustUsageProblem): SlashCommandNotice {
  const usage = `Usage: /approvals ${trustVerb(problem.believe)} <server> <hint…> — hints are ${TOOL_ANNOTATION_HINTS.join(', ')}.`;
  const perHint =
    'Trust is per hint and per server: you may believe a server’s readOnlyHint while disbelieving ' +
    'its openWorldHint.';
  if (problem.kind === 'trust-missing-server') {
    return {
      title: `Which server should this ${trustVerb(problem.believe)}?`,
      lines: [
        'Name the server by the key you gave it under mcpServers in your config — that is the only ' +
          'identity a server has here.',
        usage,
        perHint,
      ],
      tone: 'warn',
    };
  }
  if (problem.kind === 'trust-missing-hints') {
    return {
      title: `Which hints should this ${trustVerb(problem.believe)} for ${problem.server}?`,
      lines: [`Name at least one hint. Nothing was changed for ${problem.server}.`, usage, perHint],
      tone: 'warn',
    };
  }
  return {
    title: `Not an annotation hint: ${problem.token}`,
    lines: [`Nothing was changed.`, usage, perHint],
    tone: 'warn',
  };
}

/**
 * Usage copy for any malformed `/approvals` subcommand. It dispatches on the problem's `kind`
 * rather than on which subcommand was typed, so a new subcommand's problems are explained by adding
 * a case here and cannot fall through to another subcommand's copy.
 *
 * **Nothing was changed** is stated on every branch, and on the [[EXT-107]] ones it is the part that
 * matters: these arrive from a command that would have REMOVED a refusal, and a user who mistyped
 * the number has to know the gate is still where they left it.
 */
export function approvalsUsageNotice(problem: ApprovalsUsageProblem): SlashCommandNotice {
  if (problem.kind === 'undeny-missing-number') {
    return {
      title: 'Which refusal should be lifted?',
      lines: [
        'Run /approvals with no argument to list them; each line is numbered. Nothing was changed.',
        UNDENY_USAGE_LINE,
      ],
      tone: 'warn',
    };
  }
  if (problem.kind === 'undeny-bad-number') {
    return {
      title: `Not a refusal number: ${problem.token}`,
      lines: [
        'It takes the number shown beside the refusal, counting from 1. Nothing was changed.',
        UNDENY_USAGE_LINE,
      ],
      tone: 'warn',
    };
  }
  return approvalsTrustUsageNotice(problem);
}

/**
 * [[EXT-107]] — the notice for a `/approvals undeny`, built from what the runner RETURNS rather
 * than from what was asked for, so it can only describe the refusal actually lifted.
 *
 * Three outcomes, and the two that are not a plain success are the ones worth the branches:
 *
 * - **A configured entry is not lifted**, because `approvals.deny` is a file the user wrote and no
 *   session command rewrites it. Saying where it lives is the whole of the help they need.
 * - **A lifted entry that `approvals.deny` ALSO matches is still refused.** Reporting the removal
 *   without that would tell the user they had opened something that is still closed — the same
 *   "offered and then refused" failure the escalation menu is written to avoid, one layer up.
 * - **A lift whose file rewrite did not land comes back tomorrow** ([[EXT-149]]). The refusal is
 *   gone for this session and still in the project file, so the promise this notice used to make
 *   unconditionally — *it will not come back in a new session* — is the one thing that is false
 *   there. The store's own error names the file and the reason the write failed; what this adds is
 *   what that means for the refusal the user just asked to lift.
 */
export function approvalsUndenyNotice(lift: ApprovalRefusalLift): SlashCommandNotice {
  if (lift.outcome === 'unknown') {
    return {
      title: `There is no refusal number ${lift.index}`,
      lines: [
        lift.count === 0
          ? 'Nothing is refused right now, so there is nothing to lift.'
          : `The list has ${lift.count}. Run /approvals to see them numbered. Nothing was changed.`,
      ],
      tone: 'warn',
    };
  }
  if (lift.outcome === 'configured') {
    return {
      title: 'That refusal is in your config',
      lines: [
        `${lift.description} comes from the approvals.deny list in your config file, so it is ` +
          'removed by editing that file. Nothing was changed.',
      ],
      tone: 'warn',
    };
  }
  // GS2-20 — a lift is recorded against the conversation like the refusal was, so the lifetime it
  // names is the conversation's: it holds if the conversation is resumed, and not in another one.
  const removal = lift.stillSaved
    ? `${lift.description} is no longer refused for the rest of this conversation — but this ` +
      'project’s saved refusals could not be updated, so it is still in that file and it will ' +
      'refuse again in any other conversation. The error reported beside this names the file and ' +
      'why it could not be written; fix that, or remove the entry from the file by hand.'
    : lift.origin === 'persisted'
      ? `${lift.description} is no longer refused, and it has been removed from this project’s ` +
        'saved refusals, so it will not come back in a new session.'
      : `${lift.description} is no longer refused for the rest of this conversation.`;
  return {
    title: lift.stillSaved ? 'Refusal lifted for this conversation only' : 'Refusal lifted',
    lines: [
      removal,
      ...(lift.stillConfigured
        ? [
            'Your approvals.deny list still matches it, so the call is still refused — remove the ' +
              'entry from your config as well to let it run.',
          ]
        : ['The next such call will be decided the way it was before you refused it.']),
    ],
    tone: lift.stillConfigured || lift.stillSaved ? 'warn' : 'info',
  };
}

/**
 * EXT-70 §4.7.1/§4.7.4 — the notice for a landed `/approvals trust` or `/approvals untrust`, built
 * from what the runner RETURNS rather than from what was asked for, so the copy can only describe
 * the trust actually in force.
 *
 * **The withdrawal half states the consequence where the withdrawal happens.** Ceasing to believe a
 * hint pushes it back to the MCP fail-closed default, and for `readOnlyHint`, `openWorldHint` and
 * `destructiveHint` that is a *weakening* — so §4.7.4 will withdraw that server's saved approvals at
 * the next call, with its own notice. That is the correct direction and is not suppressed; what
 * would be wrong is for the user to meet it as a surprise three turns later. `idempotentHint` is the
 * one hint no weakening move names, so withdrawing it invalidates nothing and the line is absent —
 * which is why the line is driven by the runner's `weakening` list rather than by "was anything
 * withdrawn".
 */
export function approvalsTrustNotice(change: McpAnnotationTrustChange): SlashCommandNotice {
  const believed =
    change.trusted.length > 0
      ? `Believed from ${change.server}: ${change.trusted.join(', ')}.`
      : `Nothing is believed from ${change.server}; every hint takes its fail-closed default.`;
  const lines: string[] = [];

  if (change.added.length > 0) {
    lines.push(`Now believing from ${change.server}: ${change.added.join(', ')}.`);
  }
  if (change.removed.length > 0) {
    lines.push(`No longer believing from ${change.server}: ${change.removed.join(', ')}.`);
  }
  if (change.added.length === 0 && change.removed.length === 0) {
    lines.push(`Nothing changed — ${change.server} was already believed on exactly those hints.`);
  }
  lines.push(believed);

  if (change.weakening.length > 0) {
    const withdrawn = change.weakening.join(', ');
    // Precise where it can be, a rule where it cannot. Naming the grants is only honest for the
    // ones this session can actually see weakened right now; for everything else the rule is
    // stated, because promising a specific withdrawal that then does not happen teaches the user
    // to disbelieve the notice.
    lines.push(
      change.invalidates.length > 0
        ? `Because ${withdrawn} is no longer believed, ${change.server}'s tools describe themselves ` +
            'as more dangerous than when you approved them. These saved approvals will be ' +
            `withdrawn the next time that tool is called, and you will be asked again: ` +
            `${change.invalidates.join('; ')}.`
        : `Withdrawing ${withdrawn} can make ${change.server}'s tools describe themselves as more ` +
            `dangerous than when you approved them, so any saved approval for ${change.server} ` +
            'made while it was believed is withdrawn the next time that tool is called, and you ' +
            'are asked again.'
    );
  }
  if (!change.configured) {
    lines.push(
      `Note: no server is configured under the key "${change.server}". A server is identified by ` +
        'your own mcpServers key, so check the spelling — policy written for a key nothing uses ' +
        'has no effect.'
    );
  }
  lines.push(
    'A believed hint never grants a server more than the same hint grants a built-in tool.',
    'Session-scoped only (not saved); run /approvals to see it.'
  );

  return {
    title: `MCP annotations believed: ${change.server}`,
    lines,
    tone: change.weakening.length > 0 ? 'warn' : 'info',
  };
}

/**
 * TUI-C18 — resolve a `/reasoning` invocation against the committed turns' reasoning (in transcript
 * order, index 0 = turn 1). Pure, so the whole selection + friendly-notice logic is unit-testable
 * without React:
 *
 * - **no arg** → the most recent turn that actually recorded thinking; if none exists, a friendly
 *   info notice (nothing to show).
 * - **`<n>`** → turn `n` (1-based). A non-positive / non-integer / out-of-range `n` → a warn notice;
 *   a valid turn that recorded no thinking → an info notice. Otherwise a `reprintReasoning` request.
 *
 * The App renders a `reprintReasoning` result as a fresh reasoning block (reusing the TUI-C15
 * styling) and a `notice` result via the shared `CommandNotice`.
 */
export function resolveReasoning(reasonings: string[], args: string[]): SlashCommandResult {
  const count = reasonings.length;
  const has = (i: number): boolean => (reasonings[i] ?? '').trim().length > 0;

  if (args.length > 0) {
    // `Number(...)` (not parseInt) so "2x"/"1.5"/"" don't silently coerce to a valid index.
    const raw = args[0];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > count) {
      return {
        notice: {
          title: `No turn ${raw}`,
          lines:
            count === 0
              ? [
                  'This session has no committed turns yet.',
                  'Ask something first, then run /reasoning.',
                ]
              : [
                  `Pick a turn between 1 and ${count} (this session has ${count} so far).`,
                  'Run /reasoning with no number for the most recent turn that recorded thinking.',
                ],
          tone: 'warn',
        },
      };
    }
    const idx = n - 1;
    if (!has(idx)) {
      return {
        notice: {
          title: `Turn ${n} has no thinking`,
          lines: [
            `Turn ${n} didn't record a thinking layer (only some models stream one).`,
            'Run /reasoning (no number) to jump to the most recent turn that did.',
          ],
        },
      };
    }
    return { reprintReasoning: { reasoning: reasonings[idx], turnNumber: n } };
  }

  // No arg: walk back to the most recent turn that recorded thinking.
  for (let i = count - 1; i >= 0; i--) {
    if (has(i)) return { reprintReasoning: { reasoning: reasonings[i], turnNumber: i + 1 } };
  }
  return {
    notice: {
      title: 'No thinking to show',
      lines: [
        'No turn in this session has recorded a thinking layer yet.',
        'Reasoning appears for models that stream a thinking / chain-of-thought layer.',
      ],
    },
  };
}

/**
 * `/debug-dump` when no `dumpDebugSession` writer is injected — the fixture agent, or the readline
 * (`--no-tui`) session, which shares this registry (GS2-8) but has no session archive writer.
 */
const DEBUG_DUMP_UNAVAILABLE_LINES = [
  'No debug-dump writer is available in this session.',
  'This is only available in a real TUI session (not the fixture agent or the --no-tui fallback).',
];

/**
 * GS2-47 — resolve whether the `/debug-dump` archive should be redacted. ON by default; opt out via
 * the config (`debugDump.redact: false`) OR the `--unsafe-no-redact` command flag. Any uncertainty
 * (no/non-object config) defaults to redacting — fail safe. `resolvedConfig` is opaque here, so this
 * reads the flag structurally without depending on the `GthConfig` type.
 */
export function resolveDebugDumpRedact(resolvedConfig: unknown, args: string[]): boolean {
  if (args.some((a) => a === '--unsafe-no-redact' || a === '--no-redact')) return false;
  const debugDump = (resolvedConfig as { debugDump?: unknown } | null | undefined)?.debugDump;
  if (
    debugDump &&
    typeof debugDump === 'object' &&
    (debugDump as { redact?: unknown }).redact === false
  ) {
    return false;
  }
  return true;
}

/**
 * The `/debug-dump` success notice (a standard 3-line CommandNotice — DL-1: no command reads as
 * "does nothing"). GS2-47 flips the default to REDACTED: when redaction ran (the default) the note
 * is softened ("secrets redacted; review before sharing") and points at the opt-out. When the user
 * opted OUT (raw archive) it is the loud, impossible-to-miss UNSANITIZED warning. Colour follows
 * DL-8 / the tone rule in maintenance/ux-guidelines.md: the safe, redacted default is normal
 * feedback (no `tone` ⇒ info), while the raw opt-out is caution and so `tone: 'warn'` (yellow) —
 * mirroring how `approvalsModeNotice` reserves yellow for the dangerous (gate-off) state. Redaction is
 * best-effort pattern-based, so even the softened note still says review-before-sharing.
 */
export function debugDumpNotice(archiveDir: string, redacted: boolean): SlashCommandNotice {
  if (redacted) {
    return {
      title: 'Debug dump written — secrets redacted',
      lines: [
        `Archive: ${archiveDir}`,
        '',
        'Secrets were redacted (API keys, tokens and auth headers replaced with <redacted>).',
        'Redaction is best-effort and pattern-based — review before sharing.',
        '',
        'To write a raw, unredacted archive: set `debugDump.redact: false` in your gsloth config,',
        'or run `/debug-dump --unsafe-no-redact`.',
      ],
    };
  }
  return {
    title: '⚠️  Debug dump written — UNSANITIZED, review before sharing',
    lines: [
      `Archive: ${archiveDir}`,
      '',
      'This archive contains the full transcript, resolved config, env info, debug log and git',
      'state AS-IS — it may include secrets: API keys, tokens, file contents, env vars.',
      'Review it carefully before sending it anywhere.',
    ],
    tone: 'warn',
  };
}

/**
 * GS2-23 — the line a surface prints the moment `/compact` starts, because the model call behind
 * it takes seconds and a command that goes quiet reads as a command that did nothing (DL-1).
 */
export const COMPACTING_LINE =
  'Compacting the conversation — the model is summarising the older messages…';

/** A count with thousands separators, so a character estimate reads at a glance. */
const formatCount = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * GS2-23 — the notice for a landed `/compact`, built from what the runner RETURNS rather than from
 * what was asked for, so it can only describe the compaction actually applied.
 *
 * It says three things, because those are the three the person cannot otherwise observe: what was
 * folded, what was kept, and how much smaller the model's context is. And it says what did NOT
 * change — the transcript on screen — because the screen is the person's record and a notice that
 * only mentioned the model would leave them expecting lines to vanish. The size is a message count
 * and a character estimate; tokens are not counted here.
 */
export function compactionNotice(
  outcome: ConversationCompaction,
  focus?: string
): SlashCommandNotice {
  if (!outcome.changed) {
    return {
      title: 'Nothing to compact',
      lines: [
        `The conversation holds ${plural(outcome.before.messages, 'message')}, and the last ` +
          `${outcome.keepRecent} are always kept word for word, so there is nothing older to fold.`,
        'Nothing was changed.',
      ],
    };
  }
  const kept =
    outcome.keptCount > outcome.keepRecent
      ? `kept the last ${outcome.keptCount} word for word (${outcome.keepRecent} were asked for; ` +
        'a tool call and its result stay together)'
      : `kept the last ${outcome.keptCount} word for word`;
  return {
    title: 'Conversation compacted',
    lines: [
      `Folded ${plural(outcome.removedCount, 'older message')} into a summary and ${kept}.`,
      `Model context: ${plural(outcome.before.messages, 'message')} (~${formatCount(outcome.before.characters)} characters) → ` +
        `${plural(outcome.after.messages, 'message')} (~${formatCount(outcome.after.characters)} characters).`,
      ...(focus && focus.trim().length > 0 ? [`Summary focus: ${focus.trim()}`] : []),
      'The transcript on screen is unchanged. This is what the model sees from the next turn on, ' +
        'and a resumed session stays compacted.',
    ],
  };
}

/** GS2-23 — `/compact` on a surface with no conversation state behind it (the fixture agent). */
export function compactionUnavailableNotice(): SlashCommandNotice {
  return {
    title: 'Compaction unavailable',
    lines: ['This session has no model conversation to compact.', 'Nothing was changed.'],
    tone: 'warn',
  };
}

/**
 * GS2-23 — `/compact` whose summary call failed, or that was refused (a turn still running). The
 * conversation is left as it was in every such case, and the notice says so before it says why.
 */
export function compactionFailedNotice(reason: string): SlashCommandNotice {
  return {
    title: 'Compaction did not happen',
    lines: [`The conversation was left unchanged: ${reason}`],
    tone: 'warn',
  };
}

/**
 * Build the default command registry. Returns a fresh array each call so callers may push
 * extension commands onto it (EXT-5) without sharing mutable module state.
 */
export function createCommandRegistry(): SlashCommand[] {
  return [
    {
      name: 'help',
      description: 'List available slash commands',
      // The help body needs the whole registry, so dispatch special-cases `/help` and
      // calls formatHelp; this stub keeps `/help` listed and self-described.
      run: () => ({ message: 'Available commands (see /help).' }),
    },
    {
      name: 'clear',
      description: 'Clear the transcript',
      // The visible feedback is the <ClearBanner>, which survives the transcript wipe because it
      // is not a transcript item, so no committed notice here.
      run: () => ({ clearTranscript: true }),
    },
    {
      name: 'compact',
      description:
        'Fold the older conversation into a summary so the model has room to keep going ' +
        '(/compact [what to focus on]; the last few messages are kept word for word)',
      // Idle-only, like /clear: it rewrites the model's thread, and the runner refuses to do that
      // underneath a running turn anyway. The surface awaits the runner and commits the notice for
      // what landed; free text after the command is the summary's focus.
      run: (_ctx, args) => {
        const focus = args.join(' ').trim();
        return { compact: focus.length > 0 ? { focus } : {} };
      },
    },
    {
      name: 'resume',
      description:
        'Pick up a saved conversation where it left off (/resume <id>, the number from ' +
        '`gth history list` or /history; no id lists the ones that can be resumed)',
      // Idle-only, like /clear and /compact: it moves the session onto another thread, and a turn
      // in flight would be writing to the one being left. The surface resolves and applies it
      // through the shared seam and commits what landed; the id is validated here so a typo is
      // named before anything is looked up.
      run: (_ctx, args) => {
        if (args.length === 0) return { resume: {} };
        const id = parseResumeId(args[0]);
        if (id === null || args.length > 1) {
          return {
            notice: {
              title: `Not a conversation id: ${args.join(' ')}`,
              lines: [
                'Usage: /resume [<id>] — the id is the number `gth history list` prints; with no ' +
                  'id it lists the conversations that can be resumed.',
              ],
              tone: 'warn',
            },
          };
        }
        return { resume: { id } };
      },
    },
    {
      name: 'debug',
      description: 'Toggle the docked debug panel',
      availableDuringRun: true,
      // State-aware: report the notice for the state the toggle will land on (the inverse of now).
      run: (ctx) => ({ toggleDebug: true, notice: debugToggleNotice(!ctx.debugVisible) }),
    },
    {
      name: 'verbose',
      description: 'Toggle tool-call detail (collapsed summary ⇄ expanded args/result)',
      availableDuringRun: true,
      // State-aware: report the notice for the state the toggle will land on (the inverse of now).
      run: (ctx) => ({ toggleTools: true, notice: toolsToggleNotice(!ctx.toolsExpanded) }),
    },
    {
      name: 'mouse',
      // The `/help` line carries the selection hint too, not just the `/mouse` feedback: someone
      // scanning `/help` because dragging stopped selecting needs the answer where they are looking.
      description:
        'Turn terminal mouse reporting on or off (/mouse on|off; no arg toggles). ' +
        'While on, hold Shift (Option in some macOS terminals) to select text',
      availableDuringRun: true,
      // Available mid-turn deliberately: the reason to reach for this is usually wanting to copy
      // something off the screen, and that urge does not wait for the run to finish.
      run: (ctx, args) => {
        if (ctx.mouseEnabled === undefined) return { notice: mouseUnavailableNotice() };
        const target = parseMouseArg(args, ctx.mouseEnabled);
        if (target === null) {
          return {
            notice: {
              title: `Unknown option: ${args[0]}`,
              lines: ['Usage: /mouse [on|off] — with no argument it toggles.'],
              tone: 'warn',
            },
          };
        }
        return { setMouse: target, notice: mouseToggleNotice(target) };
      },
    },
    {
      name: 'approvals',
      description:
        'Show or switch the approvals mode ' +
        `(/approvals ${APPROVAL_RUNGS.join('|')}; no arg shows it and offers a picker), ` +
        'lift a refusal (/approvals undeny <number>), ' +
        'or believe an MCP server’s annotation hints (/approvals trust|untrust <server> <hint…>)',
      // Available mid-turn so the user can change how the run's REMAINING tool calls are handled
      // (EXT-12's reason, generalized to the rung). The surface owns the runner posture, so it
      // applies the change and commits the notice for the landed state.
      //
      // CFG-27 retired `/auto-approve` and `/bypass-approve` with the three-mode vocabulary they
      // named. Neither maps onto the ladder honestly — "auto-approve off" had to mean one of two
      // different rungs — and `/approvals <rung>` says exactly what it will do.
      availableDuringRun: true,
      run: (_ctx, args) => {
        const action = parseApprovalsArg(args);
        if (action === null) {
          return {
            notice: {
              title: `Unknown option: ${args[0]}`,
              lines: [
                `Usage: /approvals [${APPROVAL_RUNGS.join('|')}] — with no argument it shows the current mode.`,
                ...APPROVAL_RUNGS.map(
                  (rung) => `${rung} — ${firstSentence(APPROVAL_RUNG_DESCRIPTIONS[rung])}`
                ),
                UNDENY_USAGE_LINE,
                TRUST_USAGE_LINE,
              ],
              tone: 'warn',
            },
          };
        }
        // A malformed `trust`/`untrust`/`undeny` is explained rather than applied: nothing is
        // changed, so the surface has nothing to do and the command answers on its own.
        if ('usage' in action) return { notice: approvalsUsageNotice(action.usage) };
        return { approvals: action };
      },
    },
    {
      name: 'exit',
      description: 'Quit the session',
      run: () => ({ exit: true }),
    },
    {
      name: 'quit',
      description: 'Quit the session (alias of /exit)',
      // GS2-8 — an equal-citizen alias, no deprecation: both names quit.
      run: () => ({ exit: true }),
    },
    {
      name: 'status',
      description: 'Show session status (mode, model, turns)',
      availableDuringRun: true,
      // GS2-8 — absorbs the old `/mode` command: the mode line (and how to change it) now reads
      // as part of one status block alongside the model and turn count already in context.
      run: (ctx) => ({
        notice: {
          title: 'Session status',
          lines: [
            `Mode: ${ctx.mode} — how the agent handles your messages this session.`,
            `Model: ${ctx.modelDisplayName || 'unknown'}`,
            `Turns so far: ${ctx.turnCount}`,
            // GS2-20 — the id a later `gth history resume` takes, or the fact that there is none.
            ctx.conversationId !== undefined
              ? `Conversation: #${ctx.conversationId} — pick it up later with ` +
                `\`gth history resume ${ctx.conversationId}\`, or switch with /resume <id>.`
              : 'Conversation: not being recorded, so this session cannot be resumed later.',
            'Restart with a different subcommand to change the mode (e.g. `gth chat`).',
          ],
        },
      }),
    },
    {
      name: 'config',
      description: 'Show the resolved configuration (read-only)',
      availableDuringRun: true,
      // Read-only discovery: surface the pre-rendered, secret-free summary the App computed from
      // the resolved config, prefixed with any load-time validation warnings (TUI-C19 — the
      // details the standing advisory line points at). Editing lives in `gth init` / the config
      // file, not here (GS2-1).
      run: (ctx) => ({ notice: configNotice(ctx.configSummary, ctx.configWarnings) }),
    },
    {
      name: 'history',
      description: 'Show recent recorded sessions (local history)',
      availableDuringRun: true,
      // Read-only discovery, mirroring /config: render the App's fail-soft, pre-built summary.
      run: (ctx) => ({ notice: historyNotice(ctx.historySummary) }),
    },
    {
      name: 'search',
      description: 'Search recorded session history (/search <terms>)',
      availableDuringRun: true,
      // Dynamic query, so it calls the App-injected fail-soft search provider (stubbable in tests).
      run: (ctx, args) => ({ notice: searchNotice(args, ctx.historySearch) }),
    },
    {
      name: 'insights',
      description: 'Show local analytics over recorded sessions (tokens, cost, top tools)',
      availableDuringRun: true,
      run: (ctx) => ({ notice: insightsNotice(ctx.insightsSummary) }),
    },
    {
      name: 'model',
      description: 'Show the current model / provider',
      availableDuringRun: true,
      run: (ctx) => ({
        notice: {
          title: `Model: ${ctx.modelDisplayName || 'unknown'}`,
          lines: [
            'This is the model answering your messages this session.',
            'Change the default via `gth init` or your gsloth config.',
          ],
        },
      }),
    },
    {
      name: 'reasoning',
      description: "Reprint a turn's thinking (/reasoning [n]; no number = latest with thinking)",
      // Read-only recall of a past turn's thinking — safe to run mid-turn, like /history and /config.
      availableDuringRun: true,
      // Pure: resolve the target from the App-provided committed reasonings; the App renders the
      // reprint (reusing TUI-C15 styling) or the friendly notice.
      run: (ctx, args) => resolveReasoning(ctx.turnReasonings ?? [], args),
    },
    {
      name: 'debug-dump',
      description:
        'Dump transcript + config + env + debug log to ~/.gsloth/debug-dumps (secrets redacted; --unsafe-no-redact keeps raw)',
      // Read-only from the transcript/thread's perspective (it only writes a diagnostic archive,
      // never mutates session state), so it's useful precisely when something is going wrong
      // mid-turn — mirrors /history, /config, /debug being availableDuringRun.
      availableDuringRun: true,
      run: (ctx, args) => {
        if (!ctx.dumpDebugSession) {
          return {
            notice: {
              title: 'Debug dump unavailable',
              lines: DEBUG_DUMP_UNAVAILABLE_LINES,
              tone: 'warn',
            },
          };
        }
        // GS2-47 — redact by default; opt out via config `debugDump.redact: false` or the
        // `--unsafe-no-redact` flag. The resolved flag is threaded into the writer AND picks the
        // notice (softened when redacted, loud "unsanitized" warning when raw).
        const redact = resolveDebugDumpRedact(ctx.resolvedConfig, args);
        const { archiveDir } = ctx.dumpDebugSession({
          transcript: ctx.transcript ?? [],
          config: ctx.resolvedConfig,
          modelDisplayName: ctx.modelDisplayName,
          redact,
        });
        return { notice: debugDumpNotice(archiveDir, redact) };
      },
    },
  ];
}

/**
 * Build the `/help` notice from a registry: one body line per command (`/name — description`),
 * followed by the calling surface's own key bindings when it supplies any (TUI-C63).
 *
 * The bindings are a PARAMETER, never a constant in this module: `/help` is the reference for the
 * surface the reader is looking at, and a key that surface does not have is worse than no entry at
 * all. A surface that passes nothing gets exactly the command list, byte for byte.
 */
export function formatHelp(
  registry: SlashCommand[],
  keyBindings: readonly KeyBindingGroup[] = []
): SlashCommandNotice {
  const lines = registry.map((c) => `/${c.name} — ${c.description}`);
  // One separator row where the commands end and the keys begin. A SPACE, not the empty string: a
  // sibling <Text> holding '' collapses to nothing in Ink's column, so an empty line here would be
  // code that claims a gap the screen never draws. Groups below need none — an unindented title
  // above indented bindings already reads as a group, and this block is long enough already.
  if (keyBindings.length > 0) lines.push(' ');
  for (const group of keyBindings) {
    lines.push(group.title);
    for (const binding of group.bindings) lines.push(`  ${binding.keys} — ${binding.description}`);
  }
  return {
    // The title states what the block actually contains, so it cannot promise keys to a surface
    // that has none.
    title: keyBindings.length > 0 ? 'Slash commands and keys' : 'Slash commands',
    lines,
  };
}

/**
 * Dispatch a parsed command against a registry. Unknown commands return a friendly hint
 * rather than throwing, so the component can render it as a system line and never forward
 * the text to the model.
 *
 * EXT-12 — when `options.duringRun` is set (a turn is streaming), commands that are not marked
 * {@link SlashCommand.availableDuringRun} are refused with a friendly notice rather than run,
 * so mid-turn input can only reach the safe, non-mutating commands (`/approvals`, `/verbose`,
 * `/debug`, …). `/help` is always allowed.
 */
export function dispatchSlashCommand(
  parsed: ParsedSlashCommand,
  registry: SlashCommand[],
  ctx: SlashCommandContext,
  options: { duringRun?: boolean } = {}
): SlashCommandResult {
  if (parsed.name === 'help') {
    // TUI-C63 — the bindings section comes from the context, so each surface advertises its own
    // keyboard and only its own.
    return { notice: formatHelp(registry, ctx.keyBindings) };
  }
  const command = registry.find((c) => c.name === parsed.name);
  if (!command) {
    return {
      notice: {
        title: `Unknown command: /${parsed.name}`,
        lines: ["That isn't a recognized slash command.", 'Run /help to see everything available.'],
        tone: 'warn',
      },
    };
  }
  if (options.duringRun && !command.availableDuringRun) {
    return {
      notice: {
        title: `/${command.name} is not available while the agent is working`,
        lines: [
          'Wait for the current turn to finish, then run it again.',
          'Commands like /approvals, /verbose and /debug do work mid-turn.',
        ],
        tone: 'warn',
      },
    };
  }
  return command.run(ctx, parsed.args);
}
