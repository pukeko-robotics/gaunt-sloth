import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * GS2-2 B7 — the flagship embed e2e for `@gaunt-sloth/review`.
 *
 * Proves the published (packed) tarballs are embeddable from OUTSIDE the workspace:
 *  - `pnpm pack` core + review into a temp dir, `npm install` the tarballs into a fresh
 *    consumer package there (workspace `file:`/`workspace:*` links play no part);
 *  - the consumer runs the exact embed script documented in packages/review/README.md
 *    (root export `@gaunt-sloth/review` + deep exports `@gaunt-sloth/core/config.js` and
 *    `@gaunt-sloth/core/utils/llmUtils.js` — the same deep-import shape
 *    pukeko-robot-controller uses) over a small fixture diff;
 *  - the model is the config-selected `fake` provider (FakeListChatModel) — hermetic, no
 *    live API calls;
 *  - asserts the embed exit-code contract in both directions:
 *      rating disabled -> exit 0 and the review text on stdout;
 *      rating enabled but no rating produced -> exit 1 with the documented warning.
 */

const REVIEW_MARKER = 'LGTM-EMBED-MARKER';

// This spec lives at packages/review/embed-e2e/; the workspace root is three levels up.
const reviewPkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(reviewPkgDir, '..', '..');

// Exactly the worked example from packages/review/README.md ("Embedding: review a diff
// programmatically") — byte-equality with the README's js fence is asserted by the drift
// guard test below, so an edit to either side fails the e2e until both match again.
const EMBED_SCRIPT = `// review-diff.mjs
import { readFileSync } from 'node:fs';
import { initConfig } from '@gaunt-sloth/core/config.js';
import {
  readBackstory,
  readGuidelines,
  readReviewInstructions,
} from '@gaunt-sloth/core/utils/llmUtils.js';
import { review } from '@gaunt-sloth/review';

const config = await initConfig({}); // loads .gsloth.config.* from the working directory
const preamble = [readBackstory(config), readGuidelines(config), readReviewInstructions(config)]
  .filter(Boolean)
  .join('\\n');
const diff = readFileSync(process.argv[2], 'utf8');

await review('embedded-review', preamble, diff, config);
process.exit(process.exitCode ?? 0);
`;

const RESOLVE_PROBE = `import { fileURLToPath } from 'node:url';
console.log('review=' + fileURLToPath(import.meta.resolve('@gaunt-sloth/review')));
console.log('core-config=' + fileURLToPath(import.meta.resolve('@gaunt-sloth/core/config.js')));
`;

const FIXTURE_DIFF = `diff --git a/src/greet.js b/src/greet.js
index 83db48f..bf269f4 100644
--- a/src/greet.js
+++ b/src/greet.js
@@ -1,3 +1,7 @@
-export function greet(name) {
-  return 'Hello ' + name;
+export function greet(name = 'world') {
+  return \`Hello \${name}\`;
 }
+
+export function shout(name) {
+  return greet(name).toUpperCase();
+}
`;

describe('@gaunt-sloth/review embed e2e (packed tarballs, temp-dir consumer)', () => {
  let tempDir: string;
  let childEnv: NodeJS.ProcessEnv;

  const writeConfig = (config: object) =>
    fs.writeFileSync(path.join(tempDir, '.gsloth.config.json'), JSON.stringify(config, null, 2));

  const runEmbedScript = () =>
    spawnSync('node', ['review-diff.mjs', 'change.diff'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: childEnv,
      timeout: 120000,
    });

  beforeAll(() => {
    // realpath: os.tmpdir() may be a symlink; import.meta.resolve returns real paths.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsloth-review-embed-')));

    // `pnpm pack` (per package dir) rewrites review's `@gaunt-sloth/core: workspace:*` to the
    // concrete version, so the tarballs install cleanly outside the workspace.
    for (const pkg of ['core', 'review']) {
      const packResult = spawnSync('pnpm', ['pack', '--pack-destination', tempDir], {
        cwd: path.join(rootDir, 'packages', pkg),
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (packResult.status !== 0) {
        throw new Error(`pnpm pack failed for ${pkg}:\n${packResult.stderr}`);
      }
    }

    // Fresh ESM consumer package in the temp dir.
    spawnSync('npm', ['init', '-y'], { cwd: tempDir, stdio: 'pipe' });
    const tempPkgPath = path.join(tempDir, 'package.json');
    const tempPkg = JSON.parse(fs.readFileSync(tempPkgPath, 'utf8'));
    tempPkg.type = 'module';
    fs.writeFileSync(tempPkgPath, JSON.stringify(tempPkg, null, 2));

    const tarballs = fs
      .readdirSync(tempDir)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => `./${f}`);
    expect(tarballs).toHaveLength(2);

    const installResult = spawnSync('npm', ['install', ...tarballs], {
      cwd: tempDir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 240000,
    });
    if (installResult.status !== 0) {
      throw new Error(`npm install failed:\n${installResult.stderr}`);
    }

    fs.writeFileSync(path.join(tempDir, 'review-diff.mjs'), EMBED_SCRIPT);
    fs.writeFileSync(path.join(tempDir, 'resolve-probe.mjs'), RESOLVE_PROBE);
    fs.writeFileSync(path.join(tempDir, 'change.diff'), FIXTURE_DIFF);

    // Clean env: drop INIT_CWD so the consumer resolves config/cwd in the temp dir, not the
    // workspace root (pnpm run leaks INIT_CWD=<repo root> — the QA-7 lesson).
    childEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
    delete childEnv.INIT_CWD;
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs the README embed example verbatim (drift guard)', () => {
    // The consumer script IS the README's worked example: extract the README's only `js`
    // fence and require byte-equality, so a change to either side fails here instead of
    // silently invalidating the "verbatim README example" guarantee.
    const readme = fs.readFileSync(path.join(reviewPkgDir, 'README.md'), 'utf8');
    const jsFences = readme.match(/```js\n[\s\S]*?```/g) ?? [];
    expect(jsFences).toHaveLength(1);
    const fenceBody = jsFences[0].replace(/^```js\n/, '').replace(/```$/, '');
    expect(fenceBody).toBe(EMBED_SCRIPT);
  });

  it('resolves @gaunt-sloth/* from the installed tarballs, not the workspace', () => {
    const result = spawnSync('node', ['resolve-probe.mjs'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: childEnv,
      timeout: 60000,
    });
    expect(result.status).toBe(0);
    const consumerModules = path.join(tempDir, 'node_modules') + path.sep;
    const resolved = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('=') as [string, string])
    );
    expect(resolved['review']).toContain(consumerModules);
    expect(resolved['core-config']).toContain(consumerModules);
  });

  it('runs the README embed script: rating disabled -> exit 0, review text on stdout', () => {
    writeConfig({
      llm: { type: 'fake', responses: [`The change looks good. ${REVIEW_MARKER}`] },
      commands: { review: { rating: { enabled: false } } },
    });

    const result = runEmbedScript();

    expect(result.stdout).toContain(REVIEW_MARKER);
    expect(result.stdout).not.toContain('Failed to run review');
    expect(result.status).toBe(0);
  });

  it('rating enabled but model produces no rating -> exit 1 with the documented warning', () => {
    writeConfig({
      llm: {
        type: 'fake',
        // Response 1 feeds the review run; response 2 feeds the rating agent, which never
        // calls the gth_review_rate tool -> no rating artifact -> the documented failure path.
        responses: [`The change looks good. ${REVIEW_MARKER}`, 'I cannot call tools.'],
      },
      commands: { review: { rating: { enabled: true } } },
    });

    const result = runEmbedScript();

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain('did not return a score');
    expect(result.status).toBe(1);
  });
});
