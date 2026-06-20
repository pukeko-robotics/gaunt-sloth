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
}

/**
 * The effects a dispatched command can request. The component interprets these; the command
 * itself stays pure (no React, no I/O) so it is trivially testable.
 */
export interface SlashCommandResult {
  /** A system line to push into the transcript (the command's user-visible output). */
  message?: string;
  /** Level for the system line; defaults to 'info'. */
  level?: string;
  /** When true, the component clears the transcript. */
  clearTranscript?: boolean;
  /** When true, the component toggles the docked debug panel (subagents + debug views). */
  toggleDebug?: boolean;
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
      run: () => ({ clearTranscript: true, message: 'Transcript cleared.' }),
    },
    {
      name: 'debug',
      description: 'Toggle the docked subagents + debug panel',
      run: () => ({ toggleDebug: true }),
    },
    {
      name: 'exit',
      description: 'Quit the session',
      run: () => ({ exit: true }),
    },
    {
      name: 'mode',
      description: 'Show the current session mode',
      run: (ctx) => ({ message: `mode: ${ctx.mode}` }),
    },
    {
      name: 'model',
      description: 'Show the current model / provider',
      run: (ctx) => ({ message: `model: ${ctx.modelDisplayName || 'unknown'}` }),
    },
  ];
}

/** Format the `/help` body from a registry (kept here so it is testable without React). */
export function formatHelp(registry: SlashCommand[]): string {
  const lines = registry.map((c) => `  /${c.name} — ${c.description}`);
  return ['Available commands:', ...lines].join('\n');
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
    return { message: formatHelp(registry) };
  }
  const command = registry.find((c) => c.name === parsed.name);
  if (!command) {
    return { message: `Unknown command: /${parsed.name} — try /help`, level: 'warn' };
  }
  return command.run(ctx, parsed.args);
}
