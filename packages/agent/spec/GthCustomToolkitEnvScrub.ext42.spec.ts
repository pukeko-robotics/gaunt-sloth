import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EXT-42 (headline, security) — real-spawn acceptance gate for the custom-tool env scrub.
 *
 * This is THE gate: QA-7's ollama smoke does NOT exercise custom-tool spawn scrubbing, so this
 * end-to-end test is the only thing proving the credential leak is closed. It must therefore be
 * airtight and FUNCTIONAL — assert the secret is absent from the actual spawned child, not just from
 * a spawn-options object shape (the object-shape check lives in GthCustomToolkit.spec.ts).
 *
 * Like GthCustomToolkitSpawnStdin.spec.ts (and unlike GthCustomToolkit.spec.ts, which mocks
 * child_process wholesale), this spawns a REAL child so it exercises the actual `env` spawn option
 * produced by buildScrubbedEnv(). A fixture secret is planted in the PARENT env
 * (`process.env.FIXTURE_SECRET`); the probe echoes its OWN environment; the fixture must be ABSENT
 * from the child (present in parent → absent in child = parity with GthDevToolkit's scrubbed shell).
 *
 * The `_SECRET` suffix is load-bearing: buildScrubbedEnv strips it via its wildcard sweep
 * (`/_SECRET$/i`). A name like `FIXTURE_KEY` would NOT match and would give a FALSE PASS, so the
 * probe deliberately reads a `_SECRET`-suffixed name.
 *
 * `executeCommand` is called directly (as in GthCustomToolkitSpawnStdin.spec.ts) to bypass the
 * parameter validator — the scrub is a spawn-time property independent of the build/validate path.
 */
describe('GthCustomToolkit executeCommand child env scrub (EXT-42, real spawn)', () => {
  let tmpDir: string;
  let probeScript: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gth-ext42-env-'));
    probeScript = path.join(tmpDir, 'env-probe.cjs');
    // Echo the fixture secret's value (empty when scrubbed) and a sentinel proving a generic var
    // (PATH) survived the scrub — so a too-aggressive scrub that nuked the whole env can't pass.
    writeFileSync(
      probeScript,
      [
        "process.stdout.write('FIXTURE=[' + (process.env.FIXTURE_SECRET || '') + ']');",
        "process.stdout.write('|PATH_PRESENT=' + (process.env.PATH ? 'yes' : 'no'));",
        '',
      ].join('\n')
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.FIXTURE_SECRET;
  });

  it('scrubs a fixture secret from the child env (present in parent → absent in child)', async () => {
    const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
    const { default: GthCustomToolkit } = await import('#src/tools/GthCustomToolkit.js');

    const secret = 'sk-fixture-should-not-leak-EXT42';
    process.env.FIXTURE_SECRET = secret;
    // Sanity: the secret really IS in the PARENT env before we spawn — so absence in the child is a
    // scrub, not a never-set no-op.
    expect(process.env.FIXTURE_SECRET).toBe(secret);

    const toolkit = new GthCustomToolkit({});
    // Keep the live notice/output chunks off the real console during the test.
    const unsubscribe = subscribeToolOutput(() => {});
    try {
      // Quote the path so a temp dir with spaces (or backslashes on Windows) survives the shell.
      const result = await toolkit['executeCommand'](`node "${probeScript}"`, 'env_probe', 20);

      // Headline: the fixture secret is GONE from the child's environment.
      expect(result).toContain('FIXTURE=[]');
      expect(result).not.toContain(secret);
      // Guard against a too-aggressive scrub: PATH (generic, not a credential) must still reach the
      // child so normal commands keep working.
      expect(result).toContain('PATH_PRESENT=yes');
      // Proof it ran to completion (not killed by the timeout).
      expect(result).toContain('completed successfully');
    } finally {
      unsubscribe();
    }
  }, 30_000);
});
