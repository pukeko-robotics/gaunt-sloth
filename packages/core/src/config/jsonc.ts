/**
 * @packageDocumentation
 * JSONC (JSON-with-comments) parsing for on-disk `.gsloth.config.json` files.
 *
 * The loader historically `JSON.parse`d config files, which rejects the two things
 * hand-edited config files most want: `//` / `/* … *​/` comments and trailing commas.
 * This wraps Microsoft's zero-dependency `jsonc-parser` so a plain `.json` config may
 * carry both, while a genuinely malformed file still fails with a clear, located error
 * (rather than silently returning `undefined`).
 *
 * `jsonc-parser` is used over a hand-rolled comment-stripper because stripping comments
 * with a regex mishandles `//` / `/*` sequences that appear *inside* string values and
 * escaped quotes; the tokenizer here respects string boundaries correctly. It has no
 * transitive dependencies and is the same parser VS Code uses for its settings files.
 */
import { parse as parseJsoncTree, type ParseError, printParseErrorCode } from 'jsonc-parser';

/**
 * Parse a JSONC string (JSON + comments + trailing commas) into a value.
 *
 * On success returns the parsed value. On a structural error (anything `JSON.parse`
 * would also reject, e.g. a missing brace or a dangling property) it throws a `SyntaxError`
 * whose message names the first problem and its 0-based character offset, so the loader's
 * existing "Failed to read config …" diagnostics stay actionable.
 *
 * @param text The file contents.
 * @param sourceLabel Optional human-readable source name, included in the error message.
 */
export function parseJsonc(text: string, sourceLabel?: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsoncTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    const where = sourceLabel ? ` in ${sourceLabel}` : '';
    throw new SyntaxError(
      `Invalid JSON/JSONC${where}: ${printParseErrorCode(first.error)} at offset ${first.offset}.`
    );
  }
  return value;
}
