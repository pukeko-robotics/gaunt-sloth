import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_PREVIEW_LINES } from '@gaunt-sloth/core/core/toolDisplay.js';
import {
  checkModelTextForExpectedContent,
  checkOutputForExpectedContent,
  checkToolWasRequested,
  modelTextWithoutToolPanels,
  requestedToolsText,
} from '../integration-tests/support/outputChecker';

/**
 * BATCH-40 — the unit pins on the integration harness's output checkers.
 *
 * The cases in `askCommand.xx-small.it.ts` now claim that two of their three assertions are
 * DETERMINISTIC: they read what the CLI printed about its own tool calls, not what the model chose
 * to say. That claim cannot be established by running the real-model gate, however many times it
 * comes back green — a green run is one sample of a model's behaviour and says nothing about
 * whether the assertion could have failed. It is established here instead, by feeding the checkers
 * output that a broken run would produce and requiring them to answer `false`.
 *
 * Each case below is one of those mutations, done to the INPUT rather than to the code, so it is
 * repeatable and costs no model call:
 *
 *  - a tool that never ran,
 *  - a tool named only in the model's prose,
 *  - a tool name forged inside a previewed file,
 *  - a nesting tool name (`gth_gh_read_file` must not answer for `read_file`),
 *  - and the important one: a marker present ONLY in the tool panel's echo of the file, which must
 *    NOT satisfy the content check. That is the defect the ticket exists to avoid rebuilding — a
 *    synthesis assertion that a tool-ran event alone can satisfy.
 *
 * The fixtures are shaped after real captured `gth ask` output on the plain surface: a
 * `Requested tools:` line per round at column 0, then a panel whose head is a status glyph and
 * whose body lines carry a four-space indent.
 */

const MARKER = 'MARKER-ASKMULTI-a1b2c3d4';

/** Written as an escape, never as a literal control byte: a raw ESC in source is invisible. */
const ESC = '\u001B';

/** A round as the CLI prints it: the request line, then the panel for the result. */
function round(toolCall: string, panelSummary: string, resultLines: string[]): string {
  return [
    '',
    `Requested tools: ${toolCall}`,
    '',
    '',
    `✓ 📁 ${panelSummary}`,
    ...resultLines.map((line) => `    ${line}`),
  ].join('\n');
}

const LISTING_ROUND = round('list_directory(path: .)', 'list_directory(path=.)', [
  '[FILE] listing-token-a1b2c3d4.txt',
  '[FILE] notes.txt',
]);

const READ_ROUND = round('read_file(path: notes.txt)', 'read_file(path=notes.txt)', [
  'Padding line 1. Nothing here is asserted on.',
  'Padding line 2. Nothing here is asserted on.',
  '… (+12 more lines)',
]);

/** A healthy two-tool run: both tools requested, and the model reports the marker in its answer. */
const HEALTHY_OUTPUT = [
  'Gaunt Sloth · ask · gemma4:12b (ollama)',
  LISTING_ROUND,
  'The directory contains listing-token-a1b2c3d4.txt and notes.txt.',
  READ_ROUND,
  `The secret marker string is ${MARKER}.`,
].join('\n');

describe('BATCH-40 integration-harness output checkers', () => {
  describe('checkToolWasRequested — the deterministic half', () => {
    it('finds each tool the CLI actually requested', () => {
      expect(checkToolWasRequested(HEALTHY_OUTPUT, 'list_directory')).toBe(true);
      expect(checkToolWasRequested(HEALTHY_OUTPUT, 'read_file')).toBe(true);
    });

    it('is false for a tool that never ran', () => {
      // The "make one of the two tools not run" mutation, done to the input: an otherwise healthy
      // run in which only the listing happened.
      const listingOnly = [
        'Gaunt Sloth · ask · gemma4:12b (ollama)',
        LISTING_ROUND,
        'The directory contains listing-token-a1b2c3d4.txt and notes.txt.',
      ].join('\n');

      expect(checkToolWasRequested(listingOnly, 'list_directory')).toBe(true);
      expect(checkToolWasRequested(listingOnly, 'read_file')).toBe(false);
      expect(checkToolWasRequested(HEALTHY_OUTPUT, 'write_file')).toBe(false);
    });

    it('is false when the model only TALKS about a tool it never called', () => {
      const talkedAbout = [
        'Gaunt Sloth · ask · gemma4:12b (ollama)',
        'I would call read_file(path: notes.txt) but I will summarise from memory instead.',
      ].join('\n');

      expect(checkToolWasRequested(talkedAbout, 'read_file')).toBe(false);
    });

    it('is false when the name is forged inside a previewed tool result', () => {
      // A read file whose own contents quote the status line. The prefix is matched at column 0,
      // and every previewed line is indented, so the quote cannot manufacture tool-run evidence.
      const forged = [
        'Gaunt Sloth · ask · gemma4:12b (ollama)',
        round('list_directory(path: .)', 'list_directory(path=.)', [
          'Requested tools: read_file(path: notes.txt)',
        ]),
      ].join('\n');

      expect(checkToolWasRequested(forged, 'list_directory')).toBe(true);
      expect(checkToolWasRequested(forged, 'read_file')).toBe(false);
    });

    it('does not let a longer tool name answer for a shorter one it ends with', () => {
      const ghOnly = ['Requested tools: gth_gh_read_file(path: README.md)'].join('\n');

      expect(checkToolWasRequested(ghOnly, 'gth_gh_read_file')).toBe(true);
      expect(checkToolWasRequested(ghOnly, 'read_file')).toBe(false);
    });

    it('finds a second tool requested in the same round', () => {
      const oneRound = 'Requested tools: list_directory(path: .), read_file(path: notes.txt)';

      expect(checkToolWasRequested(oneRound, 'list_directory')).toBe(true);
      expect(checkToolWasRequested(oneRound, 'read_file')).toBe(true);
    });

    it('reads through SGR colour escapes', () => {
      const coloured = `${ESC}[2mRequested tools: read_file(path: notes.txt)${ESC}[0m`;

      // The escape sits before the prefix, so a checker that did not strip it would see a line
      // that does not start at column 0 and answer false.
      expect(requestedToolsText(coloured).trim()).toBe('read_file(path: notes.txt)');
      expect(checkToolWasRequested(coloured, 'read_file')).toBe(true);
    });
  });

  describe('checkModelTextForExpectedContent — the probabilistic half, kept honest', () => {
    it('accepts a marker the model reported in its own answer', () => {
      expect(checkModelTextForExpectedContent(HEALTHY_OUTPUT, MARKER)).toBe(true);
    });

    it('REJECTS a marker that appears only inside the tool panel', () => {
      // The defect this ticket exists to avoid rebuilding. A tool ran and its result — containing
      // the marker — was echoed to stdout, but the model never used it. The plain
      // `checkOutputForExpectedContent` cannot tell that apart from a real answer, which is exactly
      // why the marker-bearing cases must not use it.
      const echoedButNotAnswered = [
        'Gaunt Sloth · ask · gemma4:12b (ollama)',
        round('read_file(path: notes.txt)', 'read_file(path=notes.txt)', [
          `The secret marker string is ${MARKER}. Do not lose it.`,
        ]),
        'I read the file.',
      ].join('\n');

      expect(checkOutputForExpectedContent(echoedButNotAnswered, MARKER)).toBe(true);
      expect(checkModelTextForExpectedContent(echoedButNotAnswered, MARKER)).toBe(false);
    });

    it('REJECTS a marker that appears only in the panel head line', () => {
      const inArgsOnly = [
        'Gaunt Sloth · ask · gemma4:12b (ollama)',
        `✓ 📁 read_file(path=${MARKER})`,
      ].join('\n');

      expect(checkModelTextForExpectedContent(inArgsOnly, MARKER)).toBe(false);
    });

    it('keeps indented prose that is not part of a panel', () => {
      // The reason the head glyph is required rather than every indented line being dropped: a
      // model may indent its answer, and a checker that stripped all indentation would red on a
      // correct one.
      const indentedProse = [
        'Here is what I found:',
        '',
        `    The secret marker string is ${MARKER}.`,
      ].join('\n');

      expect(checkModelTextForExpectedContent(indentedProse, MARKER)).toBe(true);
    });

    it('stops dropping after the most body lines a panel can carry', () => {
      // The panel body is bounded: the capped preview plus one overflow marker. An unbounded strip
      // would keep eating indented lines and swallow an answer that merely follows a panel — the
      // over-stripping direction of the same defect. Within the bound an indented answer IS still
      // dropped, which is the residual this bound narrows rather than removes.
      const body = [
        ...Array.from(
          { length: TOOL_OUTPUT_PREVIEW_LINES },
          (_unused, index) => `Padding line ${index + 1}. Nothing here is asserted on.`
        ),
        '… (+4 more lines)',
      ];
      const panelThenIndentedAnswer = [
        round('read_file(path: notes.txt)', 'read_file(path=notes.txt)', body),
        `    The secret marker string is ${MARKER}.`,
      ].join('\n');

      expect(checkModelTextForExpectedContent(panelThenIndentedAnswer, MARKER)).toBe(true);
    });

    it('stays case-insensitive, like the plain checker', () => {
      const recased = `The secret marker string is ${MARKER.toLowerCase()}.`;

      expect(checkModelTextForExpectedContent(recased, MARKER)).toBe(true);
    });

    it('drops the whole panel body and nothing after it', () => {
      const stripped = modelTextWithoutToolPanels(HEALTHY_OUTPUT);

      expect(stripped).not.toContain('[FILE] listing-token-a1b2c3d4.txt');
      expect(stripped).not.toContain('Padding line 1.');
      expect(stripped).toContain(
        'The directory contains listing-token-a1b2c3d4.txt and notes.txt.'
      );
      expect(stripped).toContain(`The secret marker string is ${MARKER}.`);
      // The request lines are the OTHER half's evidence and are not panels, so they survive.
      expect(stripped).toContain('Requested tools: read_file(path: notes.txt)');
    });
  });
});
