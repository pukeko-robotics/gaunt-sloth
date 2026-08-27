import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runGth } from './support/commandRunner';
import {
  checkModelTextForExpectedContent,
  checkOutputForExpectedContent,
} from './support/outputChecker';
import { plantedMarkerFile } from './support/plantedMarkerFile';

/**
 * QA-8 xx-small tier — the smallest capability floor. A whole-agent marker/synthesis smoke ported
 * from the QA-7 ollama bash smoke (since retired, QA-8) into the vitest harness.
 *
 * Provider-agnostic: it runs under whatever provider `pnpm run it <provider>` selected. gemma4:12b
 * is proven to pass it (that is what makes it the xx-small floor).
 *
 * Contract per case: plant a UNIQUE, RANDOM marker in a per-case subdir the CLI runs in; the prompt
 * forces a read_file tool call; then assert BOTH
 *   - `Requested tools:` is present            → a tool actually ran, AND
 *   - the marker is in the MODEL'S OWN TEXT    → the answer was synthesized from the tool result
 * This is exactly the GS2-59 class of regression (gemma-over-ollama returned EMPTY content on the
 * post-tool turn while every unit test stayed green). The random suffix guards against a
 * stale-output false pass.
 *
 * **The second assertion is a claim about the model's answer, and it is built so that only the
 * answer can satisfy it.** The plain surface prints a tool PANEL carrying up to
 * `TOOL_OUTPUT_PREVIEW_LINES` lines of each tool RESULT, so a marker inside that window reaches
 * stdout on a successful read whether or not the model ever used it — searching the raw output for
 * it would be a tool-ran check wearing a synthesis check's name, which is what this file used to
 * do with a one-line marker file. Two things stop it now, both from BATCH-40:
 *
 *  - `plantedMarkerFile` pads the planted file past the preview cap, so the panel truncates the
 *    marker away rather than echoing it — asserted, not assumed, by
 *    `packages/app/spec/itPlantedMarkerFile.spec.ts`, which renders that content through the
 *    production tool-display renderer at the real cap;
 *  - `checkModelTextForExpectedContent` searches the output with the panels stripped out, so a read
 *    that lands its preview window on the marker anyway still cannot satisfy the assertion.
 *
 * What each case therefore proves is: a tool ran, and the model's own words carry a string it could
 * only have got from the tool's result. The discrimination case at the bottom proves the check
 * still bites when the asserted marker was never on disk.
 *
 * Topology (load-bearing): the provider config is discovered UP-TREE at
 * `workdir/.gsloth.config.json`, while file reads anchor on the CLI's cwd (the case subdir). So the
 * marker MUST live in the subdir, and the subdir MUST be under `workdir/` for the up-tree walk to
 * find workdir's config. Discovery walks up from INIT_CWD, which the harness sets explicitly to
 * each spawn's working directory — see support/cliUnderTest.mjs.
 *
 * Do NOT read these cases as the guard on that assignment. Measured: drop it, and the value pnpm
 * exports leaks in, discovery starts at the repository root, and this case still PASSES — the
 * toolkit's allowed root widens to the whole repository, so the agent finds the planted marker by
 * searching for it, and meanwhile the run has quietly switched to whatever provider the
 * repository's own developer config names. It goes red only when INIT_CWD is pointed somewhere
 * that has a config and no marker beneath it. The assignment is pinned by unit test instead, in
 * packages/app/spec/itHarnessCliUnderTest.spec.ts.
 *
 * temperature:0 (ollama config) makes each verb deterministic; retry:2 (vitest-it.config.ts) only
 * absorbs residual nondeterminism — neither is re-implemented here.
 */

const WORKDIR = path.resolve('./packages/app/integration-tests/workdir');
const PROMPT =
  '"Read the file marker.txt using your tools and report the exact secret marker string it contains."';

// Per-case subdirs created under workdir/, torn down in afterAll (runs even if a case throws).
const createdDirs: string[] = [];

/**
 * Plant `marker.txt` in a fresh per-case subdir. `markerOverride` is for the discrimination case,
 * which needs the file to carry a marker that is deliberately NOT the one it asserts on; every
 * other case takes the generated random one.
 */
function plantCase(label: string, markerOverride?: string): { dir: string; marker: string } {
  const rand = randomBytes(4).toString('hex');
  const marker = markerOverride ?? `MARKER-${label.toUpperCase()}-${rand}`;
  const dir = path.join(WORKDIR, `xxs-${label}-${rand}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), plantedMarkerFile(marker), 'utf8');
  createdDirs.push(dir);
  return { dir, marker };
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The message every arm's synthesis assertion carries — one wording, one meaning. */
const SYNTHESIZED =
  "the marker must appear in the MODEL'S OWN text — it sits past the tool panel's preview window and the panels are stripped before the search, so only an answer built from the tool result can carry it";

describe('xx-small marker/synthesis smoke (QA-8, ported from the QA-7 ollama smoke)', () => {
  it('ask: reads a planted file and synthesizes its unique marker', async () => {
    const { dir, marker } = plantCase('ask');
    const output = await runGth(['ask', PROMPT], undefined, dir);
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    expect(checkModelTextForExpectedContent(output, marker), SYNTHESIZED).toBe(true);
  });

  it('exec -m: reads a planted file and synthesizes its unique marker', async () => {
    const { dir, marker } = plantCase('exec');
    const output = await runGth(['exec', '-m', PROMPT], undefined, dir);
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    expect(checkModelTextForExpectedContent(output, marker), SYNTHESIZED).toBe(true);
  });

  it('code --no-tui: reads a planted file and synthesizes its unique marker', async () => {
    const { dir, marker } = plantCase('code');
    const output = await runGth(['code', '--no-tui', PROMPT], undefined, dir);
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    expect(checkModelTextForExpectedContent(output, marker), SYNTHESIZED).toBe(true);
  });

  // Discrimination proof — the permanent replacement for the bash smoke's SMOKE_FORCE_FAIL knob,
  // now running EVERY time. Plant a DECOY marker file, run `ask`, then assert the marker/synthesis
  // check would BITE on a broken synthesis: a tool DID run (reproducing GS2-59's "successful tool
  // call"), yet the asserted marker — which the model can never produce, because it read the decoy —
  // is ABSENT from the output.
  //
  // Asserted DIRECTLY (tool-ran == true AND asserted-marker == false) rather than via `it.fails`.
  // `it.fails` would also "pass" if the body threw for the WRONG reason — a no-tool-call, or a
  // transient the `retry:0` no longer absorbs — so it could go green without ever exercising the
  // marker check. This plain form passes ONLY for the intended reason (tool ran + wrong/empty
  // synthesis, the exact GS2-59 signature) and fails loudly if the tool didn't run or if the marker
  // ever appears. Deterministic at temp:0, so the global retry:2 never fires (it only absorbs a rare
  // transient here — harmless, no inverted expectation to interact with).
  //
  // The decoy file is planted through the same `plantedMarkerFile` shape as the positive arms, so
  // this case is structurally the run they are: the only difference is which string is asserted.
  it('discrimination: a tool runs but the asserted marker is ABSENT when the file holds a decoy (proves the check bites)', async () => {
    const { dir } = plantCase('decoy', 'DECOY-NOT-THE-ASSERTED-MARKER');
    // NEVER written to disk — unreadable by design.
    const assertedMarker = `MARKER-ASKDECOY-${randomBytes(4).toString('hex')}`;
    const output = await runGth(['ask', PROMPT], undefined, dir);
    // The tool DID run (reproduces GS2-59's "successful tool call") — so an absent marker below is
    // specifically a broken/empty synthesis, not a crash or a no-tool-call.
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    // The marker/synthesis check bites: the asserted marker (never on disk) is ABSENT from the
    // model's own text — the exact predicate the three arms above assert as TRUE, so this is the
    // control on that predicate and not on some neighbouring one.
    expect(
      checkModelTextForExpectedContent(output, assertedMarker),
      "asserted marker must be ABSENT from the model's text — the model read the decoy"
    ).toBe(false);
    // And absent from the raw output too, panels included: nothing anywhere in the run can have
    // produced a string that was never written down.
    expect(
      checkOutputForExpectedContent(output, assertedMarker),
      'asserted marker must be ABSENT from the whole output — it was never on disk'
    ).toBe(false);
  });
});
