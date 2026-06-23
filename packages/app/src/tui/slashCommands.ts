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
   * EXT-12 — when true, the component flips the runner's session-scoped yolo flag (shell
   * commands auto-approved this session) and commits the resulting-state notice. The command
   * itself stays pure: it cannot read the runner's flag, so the App owns the actual toggle and
   * the notice (mirroring how `/tools` / `/debug` defer their state-aware copy to the App).
   */
  toggleYolo?: boolean;
  /** When true, the component quits the app (runs `onExit`). */
  exit?: boolean;
}

/** A single registered slash command. `run` is pure: context in, result out. */
export interface SlashCommand {
  /** The name without the leading slash, e.g. `help`. Matched case-insensitively. */
  name: string;
  /** One-line description shown by `/help`. */
  description: string;
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
 * The notice for the `/yolo` toggle (EXT-12), given the RESULTING (post-toggle) state. Shared so
 * the command reports exactly the state the App applies. ON is rendered 'warn' (yellow) because it
 * disables the approval gate for the session; OFF is 'info'.
 */
export function yoloToggleNotice(yolo: boolean): SlashCommandNotice {
  return yolo
    ? {
        title: 'yolo ON — shell commands auto-approved this session',
        lines: [
          'run_shell_command will now execute WITHOUT the per-command approval prompt.',
          'Session-scoped only (not saved); run /yolo again to require approvals.',
          'The hardline safety floor still blocks catastrophic commands.',
        ],
        tone: 'warn',
      }
    : {
        title: 'yolo OFF — approvals required',
        lines: [
          'run_shell_command will prompt for approval again before each command.',
          'Run /yolo to re-enable session-wide auto-approval.',
        ],
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
      // The visible feedback is the live-frame <ClearBanner> (rendered outside <Static> so it
      // survives the transcript wipe), so no committed notice here.
      run: () => ({ clearTranscript: true }),
    },
    {
      name: 'debug',
      description: 'Toggle the docked subagents + debug panel',
      // State-aware: report the notice for the state the toggle will land on (the inverse of now).
      run: (ctx) => ({ toggleDebug: true, notice: debugToggleNotice(!ctx.debugVisible) }),
    },
    {
      name: 'tools',
      description: 'Toggle tool-call detail (collapsed summary ⇄ expanded args/result)',
      // State-aware: report the notice for the state the toggle will land on (the inverse of now).
      run: (ctx) => ({ toggleTools: true, notice: toolsToggleNotice(!ctx.toolsExpanded) }),
    },
    {
      name: 'yolo',
      description: 'Toggle session-wide shell auto-approval (no per-command prompt)',
      // State-aware: the App owns the runner flag, so it flips it and commits the notice for the
      // landed state (the command can't read the flag here). EXT-12.
      run: () => ({ toggleYolo: true }),
    },
    {
      name: 'exit',
      description: 'Quit the session',
      run: () => ({ exit: true }),
    },
    {
      name: 'mode',
      description: 'Show the current session mode',
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
      name: 'model',
      description: 'Show the current model / provider',
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
 */
export function dispatchSlashCommand(
  parsed: ParsedSlashCommand,
  registry: SlashCommand[],
  ctx: SlashCommandContext
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
  return command.run(ctx, parsed.args);
}
