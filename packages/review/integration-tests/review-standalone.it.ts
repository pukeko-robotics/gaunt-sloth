import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Standalone @gaunt-sloth/review integration test', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should work as a standalone package outside the workspace', async () => {
    // Create a temporary directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsloth-review-standalone-'));

    const rootDir = path.resolve('.');

    // Pack both core and review tarballs directly into the temp directory.
    // Pack each package from its own dir with `pnpm pack` (not `npm pack -w`):
    // the repo moved to pnpm workspaces (no npm `workspaces` field in the root
    // package.json, so `npm pack -w` finds nothing), and `pnpm pack` also
    // rewrites review's `@gaunt-sloth/core: workspace:*` dependency to a concrete
    // version so the tarball installs cleanly outside the workspace.
    for (const pkg of ['core', 'review']) {
      const packResult = spawnSync('pnpm', ['pack', '--pack-destination', tempDir], {
        cwd: path.join(rootDir, 'packages', pkg),
        stdio: 'pipe',
      });
      if (packResult.status !== 0) {
        throw new Error(`Command failed: pnpm pack (${pkg})\n${packResult.stderr}`);
      }
    }

    // Initialize a fresh package.json in the temp directory
    spawnSync('npm', ['init', '-y'], { cwd: tempDir, stdio: 'pipe' });

    // Set type to module since @gaunt-sloth packages use ESM
    const tempPkgPath = path.join(tempDir, 'package.json');
    const tempPkg = JSON.parse(fs.readFileSync(tempPkgPath, 'utf8'));
    tempPkg.type = 'module';
    fs.writeFileSync(tempPkgPath, JSON.stringify(tempPkg, null, 2));

    // Find the packed tarballs by glob (version-independent)
    const tarballs = fs
      .readdirSync(tempDir)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => `./${f}`);

    // Install the packed tarballs (use spawnSync to avoid shell injection)
    const installResult = spawnSync('npm', ['install', ...tarballs], {
      cwd: tempDir,
      stdio: 'pipe',
    });
    if (installResult.status !== 0) {
      throw new Error(`Command failed: npm install ${tarballs.join(' ')}\n${installResult.stderr}`);
    }

    // Write a minimal config: file content source, fake LLM, no rating
    const config = {
      llm: {
        type: 'fake',
        responses: ['Code Review\n\nScore: 8/10 PASS'],
      },
      contentSource: 'file',
      commands: {
        pr: {
          contentSource: 'file',
          rating: { enabled: false },
        },
      },
    };
    fs.writeFileSync(path.join(tempDir, '.gsloth.config.json'), JSON.stringify(config, null, 2));

    // Copy a test file to review
    fs.copyFileSync(
      path.join(rootDir, 'packages/app/integration-tests/workdir/filewithgoodcode.js'),
      path.join(tempDir, 'filewithgoodcode.js')
    );

    // Run the review CLI from the installed package using spawnSync
    // to capture stdout regardless of exit code
    // Build a clean env: remove INIT_CWD so the child process uses its own cwd
    // (otherwise it inherits the workspace root and picks up the wrong config)
    const childEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
    delete childEnv.INIT_CWD;

    const reviewBin = path.join(tempDir, 'node_modules', '.bin', 'gaunt-sloth-review');
    const result = spawnSync('node', [reviewBin, 'filewithgoodcode.js'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: childEnv,
      timeout: 60000,
    });

    const output = result.stdout;

    // Assert the review output contains expected markers (score, PASS/FAIL)
    // This proves @gaunt-sloth/review works as a standalone package
    expect(output).toContain('PASS');
    expect(output).toMatch(/\d+\/10/);
  });
});
