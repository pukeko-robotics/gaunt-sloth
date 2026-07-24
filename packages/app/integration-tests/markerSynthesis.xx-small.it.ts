import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCommandWithArgs } from './support/commandRunner';
import { checkOutputForExpectedContent } from './support/outputChecker';

/**
 * QA-8 xx-small tier — the smallest capability floor. A whole-agent marker/synthesis smoke ported
 * from the QA-7 ollama bash smoke (ollama-smoke-it/run-ollama-smoke.sh) into the vitest harness.
 *
 * Provider-agnostic: it runs under whatever provider `pnpm run it <provider>` selected. gemma4:12b
 * is proven to pass it (that is what makes it the xx-small floor).
 *
 * Contract per case (identical to the bash smoke): plant a UNIQUE, RANDOM marker in a per-case
 * subdir the CLI runs in; the prompt forces a read_file tool call; then assert BOTH
 *   - `Requested tools:` is present  → a tool actually ran, AND
 *   - the planted marker is present  → the answer was SYNTHESIZED from the tool result
 * The marker never appears in the tool-call echo (that line shows only the filename), so "output
 * contains the marker" is a genuine synthesis check, not a tool-ran check. This is exactly the
 * GS2-59 class of regression (gemma-over-ollama returned EMPTY content on the post-tool turn while
 * every unit test stayed green). The random suffix guards against a stale-output false pass.
 *
 * Topology (load-bearing): the provider config is discovered UP-TREE at
 * `workdir/.gsloth.config.json`, while file reads anchor on the CLI's cwd (the case subdir). So the
 * marker MUST live in the subdir, and the subdir MUST be under `workdir/` for the up-tree walk to
 * find workdir's config. `npx gth` resets INIT_CWD to the spawn cwd, so discovery starts at the
 * subdir (this is why the harness uses `npx gth`, not `node cli.js`, which would leak INIT_CWD).
 *
 * temperature:0 (ollama config) makes each verb deterministic; retry:2 (vitest-it.config.ts) only
 * absorbs residual nondeterminism — neither is re-implemented here.
 */

const WORKDIR = path.resolve('./packages/app/integration-tests/workdir');
const PROMPT =
  '"Read the file marker.txt using your tools and report the exact secret marker string it contains."';

// Per-case subdirs created under workdir/, torn down in afterAll (runs even if a case throws).
const createdDirs: string[] = [];

function plantCase(label: string, fileContentTemplate: string): { dir: string; marker: string } {
  const rand = randomBytes(4).toString('hex');
  const marker = `MARKER-${label.toUpperCase()}-${rand}`;
  const dir = path.join(WORKDIR, `xxs-${label}-${rand}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'marker.txt'),
    fileContentTemplate.replace('__MARKER__', marker),
    'utf8'
  );
  createdDirs.push(dir);
  return { dir, marker };
}

const MARKER_FILE = 'The secret marker string is __MARKER__. Do not lose it.\n';

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('xx-small marker/synthesis smoke (QA-8, ported from the QA-7 ollama smoke)', () => {
  it('ask: reads a planted file and synthesizes its unique marker', async () => {
    const { dir, marker } = plantCase('ask', MARKER_FILE);
    const output = await runCommandWithArgs('npx', ['gth', 'ask', PROMPT], undefined, dir);
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    expect(
      checkOutputForExpectedContent(output, marker),
      'marker must be synthesized from the tool result'
    ).toBe(true);
  });

  it('exec -m: reads a planted file and synthesizes its unique marker', async () => {
    const { dir, marker } = plantCase('exec', MARKER_FILE);
    const output = await runCommandWithArgs('npx', ['gth', 'exec', '-m', PROMPT], undefined, dir);
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    expect(
      checkOutputForExpectedContent(output, marker),
      'marker must be synthesized from the tool result'
    ).toBe(true);
  });

  it('code --no-tui: reads a planted file and synthesizes its unique marker', async () => {
    const { dir, marker } = plantCase('code', MARKER_FILE);
    const output = await runCommandWithArgs(
      'npx',
      ['gth', 'code', '--no-tui', PROMPT],
      undefined,
      dir
    );
    expect(checkOutputForExpectedContent(output, 'Requested tools:'), 'a tool must have run').toBe(
      true
    );
    expect(
      checkOutputForExpectedContent(output, marker),
      'marker must be synthesized from the tool result'
    ).toBe(true);
  });

  // Discrimination proof — the permanent replacement for the bash smoke's SMOKE_FORCE_FAIL knob,
  // now running EVERY time. Plant a DECOY marker file, run `ask`, and assert the output contains the
  // REAL asserted marker — which the model can never produce, because it read the decoy. The inner
  // marker assertion therefore FAILS deterministically, so the `fails: true` expectation PASSES.
  // This proves the marker/synthesis assertion genuinely bites on a broken/empty synthesis (the
  // GS2-59 signature: a successful tool call + a clean exit, but the wrong/empty answer).
  //
  // `retry: 0` is deliberate (Task-1 empirical finding): with the global `retry: 2`, a bare
  // `it.fails` re-runs the body the FULL retry count — 3 real-LLM calls — because vitest marks the
  // task failed BEFORE applying the fails() inversion, so the retry scheduler still fires. It stays
  // correct (all 3 attempts fail the inner assertion, so the expected-fail still passes and can
  // never false-green), but it wastes two extra ollama calls every run. `{ fails: true, retry: 0 }`
  // keeps the `it.fails` semantics while pinning it to a single deterministic attempt. The counter
  // logs exactly one body invocation; see task-1-report.md.
  let decoyAttempts = 0;
  it(
    'discrimination: the asserted marker is ABSENT when the file holds a decoy (proves the check bites)',
    { fails: true, retry: 0 },
    async () => {
      decoyAttempts += 1;

      console.log(`[xx-small decoy] body invocation #${decoyAttempts}`);
      const rand = randomBytes(4).toString('hex');
      const assertedMarker = `MARKER-ASKDECOY-${rand}`; // NEVER written to disk — unreadable by design
      const dir = path.join(WORKDIR, `xxs-decoy-${rand}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'marker.txt'),
        'The secret marker string is DECOY-NOT-THE-ASSERTED-MARKER. Do not lose it.\n',
        'utf8'
      );
      createdDirs.push(dir);
      const output = await runCommandWithArgs('npx', ['gth', 'ask', PROMPT], undefined, dir);
      // Sanity: the tool DID run (reproduces GS2-59's "successful tool call") — so the failure below
      // is specifically the missing asserted marker, not a crash / no-tool-call.
      expect(checkOutputForExpectedContent(output, 'Requested tools:')).toBe(true);
      // The assertion that MUST fail: the asserted marker never appears (the model read the decoy).
      expect(checkOutputForExpectedContent(output, assertedMarker)).toBe(true);
    }
  );
});
