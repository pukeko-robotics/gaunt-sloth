import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CFG-79 — `contentSourceConfig.git.mergeBase` against a REAL git repository.
 *
 * The fixture reproduces issue #460: a feature branch forks from `main`, then `main` gains a
 * commit the branch does not have, and the branch carries one committed file plus an uncommitted
 * edit. Diffing the working tree against `main`'s tip reports `main`'s new file as deleted by the
 * branch; diffing against the merge base must not, and must still include both the committed
 * branch work and the uncommitted edit.
 *
 * Portability (this runs on the Windows and macOS unit cells too): the branch name is set with
 * `symbolic-ref` rather than trusting `init.defaultBranch`; identity, signing, hooks and line
 * endings are pinned in the fixture's own config; files are written with `\n`; and assertions
 * are on diff substrings, never on paths. git runs in the process cwd, as it does for `gth
 * review`, so the spec changes into the fixture and changes back before removing it (Windows
 * cannot remove the current directory). Repository-locating GIT_* variables are cleared for the
 * duration so a spec run from inside a git hook cannot aim these commands at the outer repo.
 */

vi.mock('@gaunt-sloth/core/utils/ProgressIndicator.js', () => {
  const ProgressIndicator = vi.fn();
  ProgressIndicator.prototype.stop = vi.fn();
  return { ProgressIndicator };
});

const REPO_LOCATING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
];

let repo: string;
let originalCwd: string;
let mergeBaseSha: string;
const savedEnv: Record<string, string | undefined> = {};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function commitFile(name: string, content: string, message: string): void {
  writeFileSync(join(repo, name), content);
  git('add', name);
  git('commit', '--no-verify', '-q', '-m', message);
}

beforeAll(() => {
  for (const key of REPO_LOCATING_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalCwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), 'gsloth-cfg79-'));
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.name', 'CFG-79 fixture');
  git('config', 'user.email', 'cfg79@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  commitFile('shared.txt', 'shared line\n', 'base');
  git('checkout', '-q', '-b', 'feature');
  commitFile('feature.txt', 'feature work\n', 'feature');
  git('checkout', '-q', 'main');
  commitFile('upstream.txt', 'merged to main after the fork\n', 'upstream');
  git('checkout', '-q', 'feature');
  // Uncommitted edit to a tracked file.
  writeFileSync(join(repo, 'shared.txt'), 'shared line\nlocal edit\n');

  // A branch whose history shares nothing with HEAD, built without a checkout.
  const tree = git('rev-parse', 'HEAD^{tree}').trim();
  const orphan = git('commit-tree', tree, '-m', 'unrelated').trim();
  git('branch', 'unrelated', orphan);

  mergeBaseSha = git('merge-base', 'main', 'HEAD').trim();
  process.chdir(repo);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(repo, { recursive: true, force: true });
  for (const key of REPO_LOCATING_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('gitDiffSource mergeBase against a real repository', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('control: diffing against the tip of main shows the upstream commit as a deletion', async () => {
    // Without this, "upstream.txt is absent" below could mean the fixture never produced the
    // phantom deletion the setting exists to avoid.
    const { get } = await import('#src/sources/gitDiffSource.js');
    const result = (await get(null, 'main')) ?? '';
    expect(result).toContain('upstream.txt');
    expect(result).toContain('-merged to main after the fork');
  });

  it('diffs the working tree against the merge base: branch commits and local edits in, upstream commits out', async () => {
    const { get } = await import('#src/sources/gitDiffSource.js');
    const result = (await get({ mergeBase: 'main' }, undefined)) ?? '';

    // Committed branch work — absent from a plain working-tree diff, so this is what proves the
    // base was used at all.
    expect(result).toContain('+feature work');
    // The uncommitted edit.
    expect(result).toContain('+local edit');
    // The commit merged to main after the fork is not reported as reversed.
    expect(result).not.toContain('upstream.txt');
    // The label names the base and the commit it resolved to.
    expect(result.split('\n')[0]).toBe(
      `Local git diff against the merge base of "main" and HEAD (${mergeBaseSha})`
    );
  });

  it('is not confused by a file named after the merge-base sha', async () => {
    const decoy = join(repo, mergeBaseSha);
    writeFileSync(decoy, 'decoy\n');
    try {
      const { get } = await import('#src/sources/gitDiffSource.js');
      const result = (await get({ mergeBase: 'main' }, undefined)) ?? '';
      expect(result).toContain('+feature work');
    } finally {
      unlinkSync(decoy);
    }
  });

  it('lets an explicit contentId win over mergeBase', async () => {
    const { get } = await import('#src/sources/gitDiffSource.js');
    const withSetting = await get({ mergeBase: 'main' }, 'main');
    const without = await get(null, 'main');
    expect(withSetting).toBe(without);
    expect(withSetting).toContain('upstream.txt');
  });

  it('fails naming the setting when the base is unknown', async () => {
    const { get } = await import('#src/sources/gitDiffSource.js');
    await expect(get({ mergeBase: 'no-such-branch' }, undefined)).rejects.toThrow(
      /^contentSourceConfig\.git\.mergeBase "no-such-branch" could not be resolved to a merge base: fatal: /
    );
  });

  it('fails naming the setting when the base shares no history with HEAD', async () => {
    const { get } = await import('#src/sources/gitDiffSource.js');
    await expect(get({ mergeBase: 'unrelated' }, undefined)).rejects.toThrow(
      'contentSourceConfig.git.mergeBase "unrelated" has no common ancestor with HEAD'
    );
  });

  it('resolveMergeBase returns the sha git merge-base prints', async () => {
    const { resolveMergeBase } = await import('#src/utils/git.js');
    await expect(resolveMergeBase('main')).resolves.toBe(mergeBaseSha);
  });
});
