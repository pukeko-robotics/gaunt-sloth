import chalk from 'chalk';
import { stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { ruleWidth } from '#src/tui/ruleWidth.js';

/**
 * Minimal, dependency-light Markdown → ANSI renderer for the Ink TUI.
 *
 * Ink's `<Text>` renders raw ANSI escape codes verbatim, so the cleanest way to get
 * terminal markdown is to turn a markdown string into an ANSI-styled string and hand it to
 * a single `<Text>`. We deliberately render this ourselves with `chalk` (already present as
 * a transitive of `ink`) rather than pulling in `marked-terminal`/`ink-markdown`:
 *
 *  - It keeps the TUI's only markdown dependency `chalk`, which Ink already ships.
 *  - It gives us total control over the **graceful plain-text fallback** the C3 brief
 *    requires: `renderMarkdown` never throws and never garbles — on any internal error it
 *    returns the original text unchanged, and content with no markdown-meaningful syntax is
 *    passed through verbatim (no stray formatting).
 *  - It is markdown-only: a TUI render concern. The `--no-tui`/readline path never imports
 *    this module, so plain/non-interactive output is unaffected.
 *
 * Supported elements: ATX headings, bold/italic (`**` / `*` / `_`), inline code, fenced
 * code blocks, unordered/ordered lists, blockquotes, links, and horizontal rules. Anything
 * unrecognised survives as plain text. This is intentionally a pragmatic subset — enough for
 * assistant chat output — not a spec-complete CommonMark implementation.
 */

/** Spaces prepended to each fenced body line so the block reads indented vs prose. */
const FENCE_INDENT = '  ';

/**
 * A dim, full-width `─` bar — the single shape for every horizontal divider this renderer
 * emits: the top and bottom of a fenced block, and a markdown `---` rule. Width comes from
 * {@link ruleWidth}, the same math `components/Rule.tsx` uses, so a divider drawn inside a
 * committed answer lines up with the ones that bracket turns instead of falling visibly short.
 *
 * An optional `label` (a fence's language tag) is inlaid at the left and the remaining columns
 * fill with `─`; a label wider than the terminal keeps a one-glyph tail rather than going negative.
 */
function dimRule(columns: number | undefined, label?: string): string {
  const width = ruleWidth(columns);
  if (!label) return chalk.dim('─'.repeat(width));
  const prefix = `── ${label} `;
  return chalk.dim(prefix + '─'.repeat(Math.max(1, width - prefix.length)));
}

/** True if the text contains any markdown syntax worth rendering. */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  // Headings, list bullets, ordered list, blockquote, fenced code, hr (line-anchored).
  if (/^[ \t]*#{1,6}\s/m.test(text)) return true;
  if (/^[ \t]*([-*+])\s+\S/m.test(text)) return true;
  if (/^[ \t]*\d+\.\s+\S/m.test(text)) return true;
  if (/^[ \t]*>\s?/m.test(text)) return true;
  if (/^[ \t]*(```|~~~)/m.test(text)) return true;
  if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/m.test(text)) return true;
  // Inline: bold/italic, inline code, links.
  if (/\*\*[^*\n]+\*\*/.test(text)) return true;
  if (/(^|[^*])\*[^*\n]+\*([^*]|$)/.test(text)) return true;
  if (/(^|[^_])_[^_\n]+_([^_]|$)/.test(text)) return true;
  if (/`[^`\n]+`/.test(text)) return true;
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) return true;
  return false;
}

/**
 * NUL-delimited sentinel that protects inline-code spans from the later inline passes.
 *
 * Written as an explicit `\x00` escape (NOT a literal NUL byte in the source) so this file
 * stays plain ASCII and git treats it as text — a literal embedded NUL makes git classify
 * the file as binary, so it cannot be line-diffed or reviewed. NUL never appears in assistant
 * prose nor in any markup the later passes emit, so the restore regex matches exactly the
 * tokens we inserted. The sentinel adds NO padding around the index, so adjacent code spans
 * and code touching surrounding text keep their original spacing exactly.
 */
const CODE_SENTINEL = '\x00';

/** Apply inline markdown (code, bold, italic, links) to a single line of text. */
function renderInline(text: string): string {
  let out = text;
  // Inline code first so its contents are not re-processed for bold/italic markers.
  // Use a placeholder pass to protect code spans.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(chalk.cyan(code));
    return `${CODE_SENTINEL}${codeSpans.length - 1}${CODE_SENTINEL}`;
  });

  // Links: [label](url) → label (dim url). Keep the label visible, show the target dimmed.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, label: string, url: string) => {
    return `${chalk.blue.underline(label)} ${chalk.dim(`(${url})`)}`;
  });

  // Bold (**text** or __text__) before italic so the double-marker wins.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => chalk.bold(t));
  out = out.replace(/__([^_\n]+)__/g, (_m, t: string) => chalk.bold(t));

  // Italic (*text* or _text_). Single markers only; the bold pass already consumed pairs.
  out = out.replace(/\*([^*\n]+)\*/g, (_m, t: string) => chalk.italic(t));
  out = out.replace(/\b_([^_\n]+)_\b/g, (_m, t: string) => chalk.italic(t));

  // Restore protected code spans. The NUL pair brackets a (possibly multi-digit) index with
  // no padding, so the spacing around each code span is restored exactly as authored.
  out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => codeSpans[Number(i)] ?? '');
  return out;
}

const HEADING_COLORS = [
  (s: string) => chalk.bold.underline.magenta(s),
  (s: string) => chalk.bold.cyan(s),
  (s: string) => chalk.bold.green(s),
  (s: string) => chalk.bold.yellow(s),
  (s: string) => chalk.bold(s),
  (s: string) => chalk.bold.dim(s),
];

export type RenderMarkdownOptions = {
  /** Terminal width for full-width fence rules; defaults to `stdout.columns`. */
  columns?: number;
};

/**
 * Render a markdown string to an ANSI-styled string suitable for a single Ink `<Text>`.
 * Never throws: on any error, or when the content has no markdown-meaningful syntax, it
 * returns the input unchanged so plain text always reads correctly.
 */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  if (!text) return text;
  if (!looksLikeMarkdown(text)) return text;
  try {
    return renderBlocks(text, options.columns ?? stdout.columns);
  } catch {
    // Graceful fallback: never garble or crash the transcript.
    return text;
  }
}

function renderBlocks(text: string, columns: number | undefined): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const raw of lines) {
    const line = raw;

    // Fenced code blocks: drop the fence markers and frame the block with dim rules instead,
    // indenting the body. The payload stays at default foreground — it is primary answer
    // content, so dimming it is what made committed answers look degraded (DL-7).
    const fenceMatch = /^[ \t]*(```|~~~)(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        const lang = fenceMatch[2].trim();
        out.push(dimRule(columns, lang || undefined));
        continue;
      }
      if (inFence && marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
        out.push(dimRule(columns));
        continue;
      }
    }
    if (inFence) {
      out.push(`${FENCE_INDENT}${line}`);
      continue;
    }

    // Horizontal rule.
    if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      out.push(dimRule(columns));
      continue;
    }

    // ATX heading.
    const heading = /^[ \t]*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2].trim());
      out.push(HEADING_COLORS[level - 1](content));
      continue;
    }

    // Blockquote.
    const quote = /^[ \t]*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(chalk.dim('▏ ') + chalk.italic(renderInline(quote[1])));
      continue;
    }

    // Unordered list item.
    const ul = /^([ \t]*)([-*+])\s+(.*)$/.exec(line);
    if (ul) {
      const indent = ul[1].replace(/\t/g, '  ');
      out.push(`${indent}${chalk.yellow('•')} ${renderInline(ul[3])}`);
      continue;
    }

    // Ordered list item.
    const ol = /^([ \t]*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      const indent = ol[1].replace(/\t/g, '  ');
      out.push(`${indent}${chalk.yellow(`${ol[2]}.`)} ${renderInline(ol[3])}`);
      continue;
    }

    // Plain paragraph line: inline formatting only.
    out.push(renderInline(line));
  }

  return out.join('\n');
}
