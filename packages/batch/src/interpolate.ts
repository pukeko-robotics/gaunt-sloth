import type { MatrixRow } from '#src/types.js';

/**
 * BATCH-1 cell-binding syntax: `{{field}}` placeholders.
 *
 * Matches a bare field name (letters/digits/`_`/`.`/`-`), optionally surrounded by whitespace
 * inside the braces (`{{ field }}` also works). Chosen over a heavier templating engine (mustache,
 * handlebars-with-helpers, …) because BATCH-1's job is a literal find/replace of csv/jsonl column
 * values into prose — no conditionals or loops belong in a prompt-executable script, and `{{x}}` is
 * the syntax #405's own case format already uses for template-ish values, so it needs no new
 * mental model for that user.
 */
const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Bind one input row into a script's content.
 *
 * - Every `{{field}}` placeholder whose `field` is a key of `row` is replaced with that value.
 * - A placeholder naming a field the row doesn't have is left untouched (fail-soft: a typo in the
 *   script doesn't blow up the run, it just doesn't get substituted — visible in the recorded
 *   per-cell content if you go looking).
 * - When the script contains **no** placeholder that matched any row field at all, the row is
 *   appended as a fenced context block instead of silently dropped. This covers the "script has no
 *   placeholders" case BATCH-1's own scope note calls out explicitly: a script that never mentions
 *   `{{...}}` still needs the row's data available to the model, just not spliced into prose.
 *
 * `row` undefined (no `--over`) is a no-op passthrough.
 */
export function bindCellContent(baseContent: string, row: MatrixRow | undefined): string {
  if (!row) {
    return baseContent;
  }

  let matchedAny = false;
  const bound = baseContent.replace(PLACEHOLDER_RE, (full, field: string) => {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      matchedAny = true;
      return row[field];
    }
    return full;
  });

  if (matchedAny) {
    return bound;
  }

  return `${bound}\n\n${formatRowAsContextBlock(row)}`;
}

/** Render a row as a small fenced block of `key: value` lines, for the no-placeholder fallback. */
function formatRowAsContextBlock(row: MatrixRow): string {
  const lines = Object.entries(row).map(([key, value]) => `${key}: ${value}`);
  return ['Batch input row for this cell:', '<batch-row>', ...lines, '</batch-row>'].join('\n');
}
