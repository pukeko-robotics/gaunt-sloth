import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_OUTPUT_PREVIEW_LINES } from '@gaunt-sloth/core/core/toolDisplay.js';
import { runGth } from './support/commandRunner';
import {
  checkModelTextForExpectedContent,
  checkOutputForExpectedContent,
  checkToolWasRequested,
} from './support/outputChecker';

/**
 * BATCH-40 — the tool-using cases here assert WHICH TOOLS RAN, not which words the model chose.
 *
 * The two cases below used to decide whether a tool had run by searching the model's prose for a
 * word: `prime`, because `filewithgoodcode.js` happens to define `isPrime`. That is an assertion
 * about vocabulary wearing the name of an assertion about tool use, and it flaked — a small model
 * answering the same question correctly in different words failed it, repeatedly and on unmodified
 * trunk. Do not put a bare word back.
 *
 * Each case now makes three separable claims, in order of how much they depend on the model:
 *
 *  1. **Which tools the CLI requested**, read from the agent's own `Requested tools:` lines. Exact,
 *     and independent of everything the model says afterwards.
 *  2. **That a tool returned this case's own directory**, read from the plain surface's tool panel,
 *     which prints the tool RESULT. Also exact — the panel is emitted by the CLI, not written by
 *     the model — and it is deliberately NOT described as evidence that the model read anything.
 *  3. **That the model's answer carries a marker it could only have got from the file.** This is
 *     the one probabilistic claim, and it is the one that must stay: without it the case goes green
 *     whenever the tools fire and the model returns nonsense.
 *
 * **Why the marker sits below the tool panel's preview window.** The plain surface previews up to
 * `TOOL_OUTPUT_PREVIEW_LINES` lines of each tool result, so a marker in the first few lines of a
 * file reaches stdout whether or not the model ever used it — which would quietly turn claim 3 back
 * into claim 1. The planted file therefore pads past that cap before the marker line, and claim 3
 * is asserted through `checkModelTextForExpectedContent`, which searches the output with the tool
 * panels removed. Belt and braces on purpose: the padding defeats the default read path, and the
 * panel-stripping defeats a read that lands its window on the marker anyway.
 *
 * The marker line starts at column 0 so a panel copy of it is distinguishable from a prose copy —
 * the panel indents every previewed line by four spaces, prose does not.
 *
 * **Prompt wording is copied from `markerSynthesis.xx-small.it.ts` rather than invented.** This file
 * is collected by every `pnpm run it <provider> xx-small` and by the small/platform CI matrices, so
 * most of the models that run it cannot be tried locally; the marker wording is the one already
 * proven across them. `aiignore.xx-small.it.ts` records what a more demanding instruction costs —
 * on claude-haiku it makes the model end the post-tool turn with empty content.
 */

const WORKDIR = path.resolve('./packages/app/integration-tests/workdir');

/** Per-case subdirs created under workdir/, torn down in afterAll (runs even if a case throws). */
const createdDirs: string[] = [];

interface PlantedCase {
  /** The case's own directory, which the CLI runs in and lists. */
  dir: string;
  /** Unique string living only past the panel preview window inside `notes.txt`. */
  marker: string;
  /** Unique filename planted beside `notes.txt`, so a listing of this dir is identifiable. */
  listingToken: string;
}

/**
 * `notes.txt`: padding well past the panel's preview cap, then the marker sentence at column 0.
 * The padding count is derived from the cap rather than hardcoded, so raising the cap cannot
 * silently move the marker back into the previewed window.
 */
function notesFileWith(marker: string): string {
  const padding = Array.from(
    { length: TOOL_OUTPUT_PREVIEW_LINES + 3 },
    (_unused, index) => `Padding line ${index + 1}. Nothing here is asserted on.`
  );
  return [...padding, `The secret marker string is ${marker}. Do not lose it.`, ''].join('\n');
}

function plantCase(label: string): PlantedCase {
  const rand = randomBytes(4).toString('hex');
  const marker = `MARKER-${label.toUpperCase()}-${rand}`;
  const listingToken = `listing-token-${rand}.txt`;
  const dir = path.join(WORKDIR, `xxs-${label}-${rand}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), notesFileWith(marker), 'utf8');
  fs.writeFileSync(
    path.join(dir, listingToken),
    'A second file, so a listing of this directory contains something unique to this case.\n',
    'utf8'
  );
  createdDirs.push(dir);
  return { dir, marker, listingToken };
}

const READ_AND_REPORT =
  'read the file notes.txt using your tools and report the exact secret marker string it contains';

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Ask Command Integration Tests', () => {
  // Test for the ask command
  it('should respond correctly to basic programming question', async () => {
    const output = await runGth(['ask', '"Which programming language does JS stand for?"']);

    // Check for expected content in the response. Unlike the tool cases below, the asserted string
    // IS the answer to the question — there is no other correct one — so this is not a bet on
    // wording.
    expect(checkOutputForExpectedContent(output, 'JavaScript')).toBe(true);
  });

  it('should use file read tool', async () => {
    const { dir, marker } = plantCase('askread');

    const output = await runGth(['ask', `"${READ_AND_REPORT}"`], undefined, dir);

    expect(
      checkToolWasRequested(output, 'read_file'),
      'the CLI must have requested read_file'
    ).toBe(true);
    expect(
      checkModelTextForExpectedContent(output, marker),
      "the marker must appear in the model's own text — it sits past the tool panel's preview window, so only an answer built from the file can carry it"
    ).toBe(true);
  });

  it('should use multiple tools', async () => {
    const { dir, marker, listingToken } = plantCase('askmulti');

    const output = await runGth(
      ['ask', `"list current dir and present list of files; ${READ_AND_REPORT}"`],
      undefined,
      dir
    );

    // 1. Both tools were requested, by name, from the CLI's own output rather than from prose.
    expect(
      checkToolWasRequested(output, 'list_directory'),
      'the CLI must have requested list_directory'
    ).toBe(true);
    expect(
      checkToolWasRequested(output, 'read_file'),
      'the CLI must have requested read_file'
    ).toBe(true);

    // 2. The listing came back and it is THIS case's directory. Satisfied by the CLI's tool panel,
    // which prints the tool result, so it holds regardless of how the model summarises the listing
    // — and it says nothing about whether the model read anything, which is claim 3's job.
    expect(
      checkOutputForExpectedContent(output, listingToken),
      "the directory listing must have returned this case's own contents"
    ).toBe(true);

    // 3. The model's answer carries the marker, which is only in the file, past the previewed
    // window, and is looked for with the tool panels stripped out.
    expect(
      checkModelTextForExpectedContent(output, marker),
      "the marker must appear in the model's own text — it sits past the tool panel's preview window, so only an answer built from the file can carry it"
    ).toBe(true);
  });

  it('--verbose should set LangChain to verbose mode in llmUtils invoke', async () => {
    const output = await runGth(['--verbose', 'ask', '"ping"']);

    // Check for expected content in the response. A LangChain-emitted literal, not model prose.
    expect(checkOutputForExpectedContent(output, 'Entering LLM run with input: {')).toBe(true);
  });
});
