/**
 * Pure, React-free slash-command layer for the Ink TUI.
 *
 * Mirrors how `viewModel.ts` keeps its fold logic out of the components: the registry and
 * the parse/dispatch helpers here are unit-testable in isolation, and the `<App>` component
 * is the only place that turns the resulting {@link SlashCommandResult} into React state /
 * side effects (clear transcript, push a system line, quit).
 *
 * The registry is a plain array so later layers (e.g. extension-registered commands, EXT-5)
 * can append more entries via {@link createCommandRegistry} without this module changing.
 */

/** Read-only session context a command may surface (e.g. `/mode`, `/model`). */
export interface SlashCommandContext {
  mode: string;
  modelDisplayName: string;
  /** Count of committed turns so far (for `/help`-style introspection if needed). */
  turnCount: number;
  /** Whether tool-call panels currently show their full args/result (drives `/tools` copy). */
  toolsExpanded: boolean;
  /** Whether the docked debug panel is currently shown (drives `/debug` copy). */
  debugVisible: boolean;
  /**
   * Pre-rendered, secret-free summary lines of the resolved config, surfaced read-only by
   * `/config` (GS2-1). The App builds these once from the resolved config (see
   * {@link formatConfigSummary}); omitted where no config is loaded (e.g. the fixture agent).
   */
  configSummary?: string[];
  /**
   * GS2-7 (B20) — pre-rendered recent-session lines for `/history`. The App builds these fail-soft
   * from the local history store (see `formatHistoryList`); omitted when no store is available
   * (history never enabled / DB missing), in which case `/history` shows an "unavailable" notice.
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
 */
export function formatConfigSummary(config: ConfigSummaryInput): string[] {
  const fmt = (v: unknown): string =>
    typeof v === 'string' ? v : Array.isArray(v) ? JSON.stringify(v) : String(v);
  const lines: string[] = [];
  lines.push(`Model: ${config.modelDisplayName || 'unknown'}`);
  lines.push(`Agent backend: ${config.agent?.backend ?? 'lean'}`);
  if (config.filesystem !== undefined) lines.push(`Filesystem: ${fmt(config.filesystem)}`);
  if (config.streamOutput !== undefined) lines.push(`Stream output: ${config.streamOutput}`);
  if (config.useColour !== undefined) lines.push(`Colour: ${config.useColour}`);
  const commandNames = config.commands ? Object.keys(config.commands) : [];
  if (commandNames.length > 0) lines.push(`Commands configured: ${commandNames.join(', ')}`);
  lines.push('Run `gth config print` for the full resolved config (secrets redacted).');
  return lines;
}

/** The `/config` notice, from the pre-rendered summary lines (or an unavailable fallback). */
export function configNotice(summary: string[] | undefined): SlashCommandNotice {
  return {
    title: 'Resolved configuration',
    lines:
      summary && summary.length > 0
        ? summary
        : ['Configuration details are not available in this session.'],
  };
}

/** Shared "history is unavailable" body (history off / DB missing), reused by all three commands. */
const HISTORY_UNAVAILABLE_LINES = [
  'No local session history is available in this session.',
  'Enable it with `history.enabled: true` in your gsloth config (local only, opt-in).',
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
  /** When true, the component toggles the docked debug panel (subagents + debug views). */
  toggleDebug?: boolean;
  /** When true, the component toggles tool-call panels between collapsed and expanded. */
  toggleTools?: boolean;
  /**
   * EXT-12 — a requested change to the runner's session-scoped auto-approve flag (shell commands
   * auto-approved this session), from the `/auto-approve` command: `'on'` / `'off'` set it
   * explicitly, `'toggle'` flips it. The command itself stays pure — it cannot read the runner's
   * flag — so the App owns the actual apply + the resulting-state notice (mirroring how `/tools`
   * / `/debug` defer their state-aware copy to the App).
   */
  autoApprove?: 'on' | 'off' | 'toggle';
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
   * commands (e.g. `/auto-approve`, `/tools`, `/debug`, `/help`, `/model`) set this so the user
   * can flip auto-approval or inspect state mid-turn without interrupting the run. Commands that
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
 * command iff its first non-whitespace character is `/`. The name is lower-cased; remaining
 * whitespace-separated tokens are the args.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
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
 */
export function slashMenuQuery(input: string): string | null {
  if (!/^\/\S*$/.test(input)) return null;
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
 * `/tools` command and the Ctrl+T key handler so the copy is single-sourced (TUI-C14).
 */
export function toolsToggleNotice(expanded: boolean): SlashCommandNotice {
  return expanded
    ? {
        title: 'Tool details: on',
        lines: [
          'Tool calls now show their full inputs and results in the chat history.',
          'Applies to new turns — run /tools again to collapse them to summaries.',
        ],
      }
    : {
        title: 'Tool details: off',
        lines: [
          'Tool calls now show as a single summary line in the chat history.',
          'Applies to new turns — run /tools again to show full inputs and results.',
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
          'Docked panel with the subagent tree and sent-to-model / raw-response views.',
          'Run /debug again to hide it; Tab cycles its views.',
        ],
      }
    : {
        title: 'Debug panel: hidden',
        lines: [
          'The docked subagent + debug views are now closed.',
          'Run /debug again to bring them back.',
        ],
      };
}

/**
 * The notice for the `/auto-approve` toggle (EXT-12), given the RESULTING (post-apply) state.
 * Shared so the command reports exactly the state the App applies. ON is rendered 'warn' (yellow)
 * because it disables the approval gate for the session; OFF is 'info'.
 */
export function autoApproveNotice(on: boolean): SlashCommandNotice {
  return on
    ? {
        title: 'Auto-approve ON — shell commands run without asking',
        lines: [
          'run_shell_command will now execute WITHOUT the per-command approval prompt.',
          'Session-scoped only (not saved); run /auto-approve off to require approvals.',
          'The hardline safety floor still blocks catastrophic commands.',
        ],
        tone: 'warn',
      }
    : {
        title: 'Auto-approve OFF — approvals required',
        lines: [
          'run_shell_command will prompt for approval again before each command.',
          'Run /auto-approve (or /auto-approve on) to re-enable session-wide auto-approval.',
        ],
      };
}

/**
 * EXT-12 — parse the `/auto-approve` argument: no arg (or `toggle`) flips; `on`/`off` (and the
 * friendly synonyms `enable`/`disable`, `true`/`false`) set explicitly. Returns `null` for an
 * unrecognized argument so the command can render a usage hint instead of guessing.
 */
export function parseAutoApproveArg(args: string[]): 'on' | 'off' | 'toggle' | null {
  if (args.length === 0) return 'toggle';
  const arg = args[0].toLowerCase();
  if (arg === 'toggle') return 'toggle';
  if (arg === 'on' || arg === 'enable' || arg === 'true') return 'on';
  if (arg === 'off' || arg === 'disable' || arg === 'false') return 'off';
  return null;
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
      // The visible feedback is the live-frame <ClearBanner> (rendered outside <Static> so it
      // survives the transcript wipe), so no committed notice here.
      run: () => ({ clearTranscript: true }),
    },
    {
      name: 'debug',
      description: 'Toggle the docked subagents + debug panel',
      availableDuringRun: true,
      // State-aware: report the notice for the state the toggle will land on (the inverse of now).
      run: (ctx) => ({ toggleDebug: true, notice: debugToggleNotice(!ctx.debugVisible) }),
    },
    {
      name: 'tools',
      description: 'Toggle tool-call detail (collapsed summary ⇄ expanded args/result)',
      availableDuringRun: true,
      // State-aware: report the notice for the state the toggle will land on (the inverse of now).
      run: (ctx) => ({ toggleTools: true, notice: toolsToggleNotice(!ctx.toolsExpanded) }),
    },
    {
      name: 'auto-approve',
      description:
        'Auto-approve shell commands this session (/auto-approve on|off; no arg toggles)',
      // Available mid-turn so the user can stop being prompted for the run's remaining tool calls
      // (EXT-12). The App owns the runner flag, so it applies the change and commits the notice for
      // the landed state (the command can't read the flag here).
      availableDuringRun: true,
      run: (_ctx, args) => {
        const action = parseAutoApproveArg(args);
        if (action === null) {
          return {
            notice: {
              title: `Unknown option: ${args[0]}`,
              lines: [
                'Usage: /auto-approve [on|off] — with no argument it toggles.',
                'When ON, shell commands run this session without the per-command prompt.',
              ],
              tone: 'warn',
            },
          };
        }
        return { autoApprove: action };
      },
    },
    {
      name: 'yolo',
      description: 'Alias for /auto-approve (toggles session-wide shell auto-approval)',
      availableDuringRun: true,
      // Back-compat alias: a bare toggle, routed through the same auto-approve apply path. EXT-12.
      run: () => ({ autoApprove: 'toggle' }),
    },
    {
      name: 'exit',
      description: 'Quit the session',
      run: () => ({ exit: true }),
    },
    {
      name: 'mode',
      description: 'Show the current session mode',
      availableDuringRun: true,
      run: (ctx) => ({
        notice: {
          title: `Session mode: ${ctx.mode}`,
          lines: [
            'This is how the agent handles your messages this session.',
            'Restart with a different subcommand to change it (e.g. `gth chat`).',
          ],
        },
      }),
    },
    {
      name: 'config',
      description: 'Show the resolved configuration (read-only)',
      availableDuringRun: true,
      // Read-only discovery: surface the pre-rendered, secret-free summary the App computed from
      // the resolved config. Editing lives in `gth init` / the config file, not here (GS2-1).
      run: (ctx) => ({ notice: configNotice(ctx.configSummary) }),
    },
    {
      name: 'history',
      description: 'Show recent recorded sessions (local, opt-in history)',
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
  ];
}

/** Build the `/help` notice from a registry: one body line per command (`/name — description`). */
export function formatHelp(registry: SlashCommand[]): SlashCommandNotice {
  return {
    title: 'Slash commands',
    lines: registry.map((c) => `/${c.name} — ${c.description}`),
  };
}

/**
 * Dispatch a parsed command against a registry. Unknown commands return a friendly hint
 * rather than throwing, so the component can render it as a system line and never forward
 * the text to the model.
 *
 * EXT-12 — when `options.duringRun` is set (a turn is streaming), commands that are not marked
 * {@link SlashCommand.availableDuringRun} are refused with a friendly notice rather than run,
 * so mid-turn input can only reach the safe, non-mutating commands (`/auto-approve`, `/tools`,
 * `/debug`, …). `/help` is always allowed.
 */
export function dispatchSlashCommand(
  parsed: ParsedSlashCommand,
  registry: SlashCommand[],
  ctx: SlashCommandContext,
  options: { duringRun?: boolean } = {}
): SlashCommandResult {
  if (parsed.name === 'help') {
    return { notice: formatHelp(registry) };
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
          'Commands like /auto-approve, /tools and /debug do work mid-turn.',
        ],
        tone: 'warn',
      },
    };
  }
  return command.run(ctx, parsed.args);
}
