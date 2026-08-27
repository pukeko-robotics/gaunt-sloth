import { TOOL_OUTPUT_PREVIEW_LINES } from '@gaunt-sloth/core/core/toolDisplay.js';

/**
 * Checks if the output contains the expected content (case-insensitive)
 * @param output - The output to check
 * @param expectedContent - The content to look for (string or array of strings)
 * @returns True if the output contains the expected content (or any string from the array), false otherwise
 */
export function checkOutputForExpectedContent(
  output: string,
  expectedContent: string | string[]
): boolean {
  // Convert output to lowercase for case-insensitive comparison
  const lowerOutput = output.toLowerCase();

  // If expectedContent is an array, check if output contains any of the strings
  if (Array.isArray(expectedContent)) {
    return expectedContent.some((content) => lowerOutput.includes(content.toLowerCase()));
  }

  // If expectedContent is a string, check if output contains it
  const lowerExpected = expectedContent.toLowerCase();
  return lowerOutput.includes(lowerExpected);
}

/**
 * BATCH-40 — the two things a case in this suite may assert about a real model run, kept apart.
 *
 * A run against a real model produces two very different kinds of evidence on the same stdout, and
 * a case that conflates them is either flaky or unable to fail:
 *
 *  - **What the CLI did** is exact. The agent prints one `Requested tools: name(args)` line per
 *    round, and the plain surface prints a tool panel per result. Neither depends on the model's
 *    wording, so an assertion built on them is deterministic.
 *  - **What the model said** is not exact, and no wording may be required of it. The only content
 *    worth asserting is content the model could not produce without the tool result — a unique
 *    planted marker — and even that must be looked for in the model's own text rather than in the
 *    panel that echoes the tool result back.
 *
 * The helpers below are the two halves. Every one of them is pinned by
 * `packages/app/spec/itOutputChecker.spec.ts`, which is what makes the deterministic half provably
 * deterministic: no number of green model runs could establish that, and a unit test does it
 * without spending one.
 */

/** SGR escapes only — the sequences `renderToolLineAnsi` and the status glyph actually emit. */
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** The prefix the agent's tool-call status middleware writes, at column 0, once per round. */
const REQUESTED_TOOLS_PREFIX = 'Requested tools: ';

/** Every status glyph `toolStatusDisplay` can put at the head of a plain-surface tool panel. */
const TOOL_PANEL_HEAD_GLYPHS = ['✓', '✗', '⚠'];

/** The indent `plainToolIndication` puts in front of every previewed line of a tool result. */
const TOOL_PANEL_INDENT = '    ';

/**
 * The most indented lines one panel can carry: the capped preview, plus the one `(+N more lines)`
 * overflow marker `capToolDisplayLines` adds beyond the cap. Imported rather than restated so
 * raising the cap cannot leave this reading short.
 */
const MAX_TOOL_PANEL_BODY_LINES = TOOL_OUTPUT_PREVIEW_LINES + 1;

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, '');
}

/**
 * The text of every `Requested tools:` line in the output, joined.
 *
 * Matched at column 0 on purpose. The line is emitted through the INFO status channel and is never
 * indented, whereas a previewed tool result is indented by four spaces — so anchoring here means a
 * file whose own contents happen to quote this prefix cannot forge tool-run evidence.
 */
export function requestedToolsText(output: string): string {
  return stripAnsi(output)
    .split('\n')
    .filter((line) => line.startsWith(REQUESTED_TOOLS_PREFIX))
    .map((line) => line.slice(REQUESTED_TOOLS_PREFIX.length))
    .join('\n');
}

/**
 * Did the CLI request this tool, by name, in a round of this run?
 *
 * The answer comes from the agent's own tool-request output, so it holds whatever the model chose
 * to say afterwards. Matching is anchored on a name boundary rather than done as a bare substring,
 * because tool names nest: a bare `read_file` search also matches `gth_gh_read_file(`.
 *
 * One limit worth knowing before asserting on a long toolset: `formatToolCalls` truncates the
 * joined line at 255 characters, so a name can be cut off when a single round requests many tools
 * with large arguments. Two or three calls a round are nowhere near it.
 */
export function checkToolWasRequested(output: string, toolName: string): boolean {
  const text = requestedToolsText(output);
  const needle = `${toolName}(`;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : text[at - 1];
    if (before === '' || before === ' ' || before === ',' || before === '\n') {
      return true;
    }
  }
  return false;
}

/**
 * The output with every plain-surface tool panel removed — what is left is the model's own text.
 *
 * **This is what stops a content assertion passing on the echo instead of the answer.** The plain
 * surface prints up to `TOOL_OUTPUT_PREVIEW_LINES` lines of each tool RESULT, so a marker planted
 * anywhere in that window reaches stdout whether or not the model ever read it, and "output
 * contains the marker" would then be a tool-ran check wearing a synthesis check's name.
 *
 * A panel is a head line (a status glyph, a space, and the call summary) followed by the run of
 * lines carrying the panel indent. Both are dropped, and **nothing else is** — the two narrowings
 * below both exist because over-stripping would silently discard a correct answer, which is the
 * same class of unfalsifiable assertion in the opposite direction:
 *
 *  - The head must carry a status glyph, rather than every indented line being dropped blindly. A
 *    model may legitimately indent its prose by four spaces, in a nested list or a fenced block.
 *  - At most `TOOL_OUTPUT_PREVIEW_LINES + 1` indented lines are dropped per panel, which is exactly
 *    what `capToolDisplayLines` can emit (the capped preview plus the `(+N more lines)` marker). An
 *    unbounded run would swallow an indented answer that merely happens to follow a panel.
 */
export function modelTextWithoutToolPanels(output: string): string {
  const lines = stripAnsi(output).split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isToolPanelHead(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let dropped = 0;
    while (
      dropped < MAX_TOOL_PANEL_BODY_LINES &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith(TOOL_PANEL_INDENT)
    ) {
      i++;
      dropped++;
    }
  }
  return kept.join('\n');
}

function isToolPanelHead(line: string): boolean {
  return TOOL_PANEL_HEAD_GLYPHS.some((glyph) => line.startsWith(`${glyph} `)) && line.includes('(');
}

/**
 * Does the MODEL's own text contain the expected content? Same case-insensitive comparison as
 * {@link checkOutputForExpectedContent}, applied to the output with the tool panels removed.
 *
 * Use this, never the plain form, for anything a tool result also contains.
 */
export function checkModelTextForExpectedContent(
  output: string,
  expectedContent: string | string[]
): boolean {
  return checkOutputForExpectedContent(modelTextWithoutToolPanels(output), expectedContent);
}
