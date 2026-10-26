/**
 * [[TUI-C111]] — which tool-call arguments are PATHS, and how a path is shortened for display.
 *
 * Both tool-call summaries (the `Requested tools:` line in `utils/llmUtils` and the tool row in
 * `core/toolDisplay`) cut a long value to fit. Most values read best from the front — a command, a
 * description, a pattern — but a path does not: in a deep tree the head is what every path shares
 * and the file name is what tells two calls apart. So a path argument is cut from the START.
 *
 * A path is recognised by the argument's NAME, never by sniffing the value: a value sniff would also
 * catch a URL, whose host is the part to keep, and a shell command, whose start is. The names are
 * the path-carrying arguments of the built-in tool schemas (the filesystem toolkit, the dev
 * toolkit, the grep tool and the review GitHub tools). The rule is by name alone, so an MCP or
 * custom tool argument with one of these names is cut the same way.
 *
 * A leaf module on purpose: `llmUtils` is loaded by many specs through `importOriginal`, and giving
 * it an edge into the tool-display module would pull that module's whole import graph in with it.
 *
 * @module
 */

/** Argument names whose values are file-system paths (a `paths` array holds one per element). */
export const PATH_ARGUMENT_NAMES: ReadonlySet<string> = new Set([
  'path',
  'paths',
  'testPath',
  'source',
  'destination',
  'cwd',
]);

/** Is the argument named `name` a path, to be cut from the start? */
export function isPathArgument(name: string): boolean {
  return PATH_ARGUMENT_NAMES.has(name);
}

const SEPARATOR = /[\\/]/u;
const NON_SEPARATOR = /[^\\/]/u;

/**
 * Advance the kept END of a cut path to its first separator, so it never opens on half a directory
 * name (`…/providers/a.ts`, not `…oviders/a.ts`). Both separators count, since a Windows path
 * arrives with backslashes. The tail is returned unchanged when it holds no separator (a file name
 * longer than the budget) or when nothing but separators would follow the one found.
 */
export function alignTailToSeparator(tail: string): string {
  const at = tail.search(SEPARATOR);
  if (at <= 0) return tail;
  const aligned = tail.slice(at);
  return NON_SEPARATOR.test(aligned) ? aligned : tail;
}

/**
 * Cut `value` to `maxLength` CHARACTERS keeping its end, behind a leading `...` — the mirror of
 * `truncateString` for the `Requested tools:` line, which counts characters rather than columns.
 * Characters are code points, so the cut never leaves half a surrogate pair at the front.
 */
export function truncatePathStart(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return '...' + alignTailToSeparator(chars.slice(chars.length - (maxLength - 3)).join(''));
}
