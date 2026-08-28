import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGth } from './support/commandRunner';

/** Fixture dir for the glob case. Its files are tracked; `.aiignore` is the stimulus under test. */
const GLOB_FIXTURE_DIR = path.join(import.meta.dirname, 'workdir', 'glob-aiignore');

/**
 * `.aiignore` end-to-end: real CLI, real model, real filesystem tools.
 *
 * **Why a neutral prompt is enough — do not make it demanding again.** What tests the filter is the
 * assertion PAIR, never the model's prose. The positive assertion requires a listing to have been
 * produced at all; the negative one then proves the filter removed the ignored entry from it. Both
 * are satisfied by the tool panel alone, which prints the raw tool output to the same stdout these
 * assertions read — so a model that reformats, annotates or summarises the listing still passes.
 *
 * A tail instruction such as "return the raw tool output only, do not add commentary or omit
 * entries" therefore buys the assertions nothing, and it measurably costs the run: on
 * claude-haiku-4-5 either half of that wording makes the model end the post-tool turn with empty
 * content and stop_reason end_turn, which fails every retry. The wording could only ever weaken
 * this test.
 */
describe('Aiignore Integration Tests', () => {
  it('should hide aiignore entries when listing the current directory', async () => {
    const output = await runGth([
      'ask',
      '"Use the list_directory tool on . and list what it returns."',
    ]);

    expect(output).toContain('aiignore-visible.txt');
    expect(output).not.toContain('aiignore-hidden.txt');
  });

  /**
   * Glob coverage. `.aiignore` is documented as ".gitignore-ish", but every other case here uses a
   * literal filename, so nothing exercised a wildcard end-to-end.
   *
   * **The discriminating pair.** `workdir/.aiignore` carries `glob-aiignore/*.secret.txt`.
   * `notes.secret.txt` matches it and is asserted ABSENT; `notes.public.txt` does not match and is
   * asserted PRESENT. `notes.public.txt` is the right control precisely because it differs from the
   * ignored file only in the segment the glob discriminates on — same directory, same extension,
   * same fixture commit, created and listed by the same tool call — so nothing but the pattern
   * match can make one appear and the other not. Drop the control and the case still passes when
   * the pattern matches everything, when the model never listed the directory at all, and when
   * `.aiignore` filtering is off entirely.
   *
   * The `existsSync` preconditions close the last hole the control cannot reach: an ignored file
   * that was never created is absent for the wrong reason, and the negative assertion would pass
   * vacuously. They also fail fast, before an API call is spent.
   *
   * **Why the pattern stays directory-qualified rather than bare `*.secret.txt`.** A bare pattern
   * would also hide `notes.secret.txt` — `shouldIgnoreFile`
   * (`packages/core/src/utils/aiignoreUtils.ts`) applies a separator-free pattern at every depth —
   * but it would hide it via a rule that reaches the whole workdir, so the case would no longer
   * distinguish "the filter matched this subdirectory's file" from "the filter matched everything
   * of that name anywhere". The qualified form keeps the assertion pinned to a pattern whose
   * anchoring is part of what is under test.
   *
   * **Why its own subdirectory.** It gives this case a short listing that cannot be perturbed by
   * the root case or by accumulated run artifacts, and it keeps these fixtures out of the root
   * listing's 10-line tool preview cap (`TOOL_OUTPUT_PREVIEW_LINES`), where they would otherwise
   * push `aiignore-visible.txt` out of the panel.
   *
   * That margin is a convenience, not the guarantee: `list_directory` emits `fs.readdir` order
   * verbatim and does **not** sort (unlike `list_directory_with_sizes`), so entry position follows
   * directory order and a hash-ordered filesystem is not obliged to preserve it. What actually
   * keeps the root case's assertions robust is that the model restates the listing in its own
   * prose, where `aiignore-visible.txt` appears regardless of where the capped panel stops —
   * observed on every real run of this file.
   */
  it('should hide entries matched by an aiignore glob while keeping the near-miss control', async () => {
    expect(
      existsSync(path.join(GLOB_FIXTURE_DIR, 'notes.secret.txt')),
      'the ignored fixture must exist on disk, or the negative assertion passes vacuously'
    ).toBe(true);
    expect(
      existsSync(path.join(GLOB_FIXTURE_DIR, 'notes.public.txt')),
      'the control fixture must exist on disk'
    ).toBe(true);

    const output = await runGth([
      'ask',
      '"Use the list_directory tool on ./glob-aiignore and list what it returns."',
    ]);

    // Control: not matched by `glob-aiignore/*.secret.txt`, so the listing must still show it.
    expect(output).toContain('notes.public.txt');
    // Matched by the glob, so the filter must have removed it from that same listing.
    expect(output).not.toContain('notes.secret.txt');
  });
});
