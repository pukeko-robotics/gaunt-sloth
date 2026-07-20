/**
 * BATCH-11 (gaunt-sloth #405 gotcha #5) — which subcommands must NOT block on STDIN.
 *
 * The CLI reads piped STDIN (a diff) before dispatch for commands like `ask`/`review`/`pr`. On a
 * non-TTY, non-closing stdin — exactly a scripted/CI invocation — that read waits for EOF, so a
 * command that never consumes stdin would hang until the parent closed it (or the user added
 * `</dev/null`). `eval` and `batch` never read piped stdin, so they must take the same fast path as
 * `--no-pipe` and dispatch immediately.
 *
 * This module owns the small, pure policy so `cli.ts` stays a thin wiring layer and the decision is
 * unit-testable without importing the CLI entry point (which runs on import).
 */

/**
 * Subcommands whose runs never consume piped stdin — the CLI implies the `--no-pipe` fast path for
 * these so they don't block waiting for stdin EOF. Keep this list narrow: only add a command here
 * once it's certain it never reads a piped diff/document.
 */
export const NON_STDIN_COMMANDS: readonly string[] = ['eval', 'batch'];

/**
 * Resolve the invoked subcommand name from commander's parsed operands.
 *
 * `operands` is `Command.parseOptions(argv).operands` — the non-option tokens, with global option
 * *values* (e.g. the `<path>` of `-c <path>`) already consumed, so they can't be mistaken for the
 * command. Returns the first operand that matches a registered command name; a positional argument
 * that merely happens to equal a command name (e.g. a suite file literally named `eval`) can't win
 * because the real subcommand always precedes its own arguments. Returns `undefined` when no
 * subcommand was given (the default-command / bare-`gth` case).
 */
export function resolveInvokedCommandName(
  commandNames: Iterable<string>,
  operands: readonly string[]
): string | undefined {
  const names = new Set(commandNames);
  return operands.find((token) => names.has(token));
}

/** Whether the given resolved subcommand name must skip the piped-stdin wait. */
export function commandSkipsStdin(commandName: string | undefined): boolean {
  return commandName !== undefined && NON_STDIN_COMMANDS.includes(commandName);
}
