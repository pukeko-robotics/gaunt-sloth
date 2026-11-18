/**
 * BATCH-57 — split a `command` target's `run` string into the argument vector that is spawned.
 *
 * `run` is NOT given to a shell. The prompt is the dangerous half of a command line, and keeping
 * every shell out of the path is what makes "the prompt is never interpreted" true by construction
 * rather than by quoting: the prompt is appended to this vector, or written to stdin, and no program
 * between gth and the agent ever parses it.
 *
 * The splitter is deliberately small:
 * - whitespace separates arguments;
 * - `'…'` and `"…"` quote literally, and adjacent quoted and unquoted parts join into one argument
 *   (`--name="a b"` is one argument, `--name=a b`);
 * - a backslash is an ordinary character, never an escape, so a Windows path such as
 *   `"C:\Program Files\nodejs\node.exe"` survives unchanged;
 * - there is no expansion of any kind.
 *
 * Because nothing is expanded, an unquoted character that a shell would treat specially — `$`,
 * a backtick, `|`, `&`, `;`, `<`, `>`, `(`, `)` — is REFUSED rather than passed through as a literal.
 * An author who wrote `run: claude -p | tee log` meant a pipe, and silently passing `|` and `tee` as
 * arguments would run something other than what they wrote. Quote the character to pass it
 * literally.
 *
 * @module
 */

const SHELL_SPECIAL = new Set(['$', '`', '|', '&', ';', '<', '>', '(', ')']);

/**
 * Split `run` into an argument vector. Throws with a message naming the problem on an unterminated
 * quote, an unquoted shell character, or an empty command.
 */
export function splitCommandLine(run: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inArg = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inArg) {
        args.push(current);
        current = '';
        inArg = false;
      }
      continue;
    }
    if (SHELL_SPECIAL.has(ch)) {
      throw new Error(
        `\`run\` contains an unquoted "${ch}" at position ${i + 1}. The command is started without ` +
          'a shell, so pipes, redirects, variables and substitutions are not available; quote the ' +
          'character to pass it as a literal argument, or put the shell logic in a script and run that.'
      );
    }
    current += ch;
    inArg = true;
  }

  if (quote) {
    throw new Error(`\`run\` has an unterminated ${quote} quote.`);
  }
  if (inArg) args.push(current);
  if (args.length === 0) {
    throw new Error('`run` is empty — name the command to start.');
  }
  return args;
}
