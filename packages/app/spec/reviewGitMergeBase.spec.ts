import { Command } from 'commander';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CFG-79 — `gth review` with `contentSourceConfig.git.mergeBase`, through the app's own command
 * and `commandUtils` copy (the path the CLI runs), against the REAL git content source in a real
 * repository. Only config loading, the review module and console/exit plumbing are stubbed, so a
 * break anywhere between the config block and the git source fails here.
 *
 * The fixture and its portability notes mirror packages/review/spec/gitDiffSourceMergeBase.spec.ts.
 */

const {
  initConfigMock,
  reviewMock,
  displayErrorMock,
  setExitCodeMock,
  getStringFromStdinMock,
  writeFailureReportMock,
  llmUtilsMock,
} = vi.hoisted(() => ({
  initConfigMock: vi.fn(),
  reviewMock: vi.fn(),
  displayErrorMock: vi.fn(),
  setExitCodeMock: vi.fn(),
  getStringFromStdinMock: vi.fn(),
  writeFailureReportMock: vi.fn(),
  llmUtilsMock: {
    readBackstory: vi.fn(),
    readGuidelines: vi.fn(),
    readReviewInstructions: vi.fn(),
    readSystemPrompt: vi.fn(),
  },
}));

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  displayError: displayErrorMock,
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  setExitCode: setExitCodeMock,
  getStringFromStdin: getStringFromStdinMock,
}));
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>()),
  ...llmUtilsMock,
}));
vi.mock('@gaunt-sloth/core/utils/ProgressIndicator.js', () => {
  const ProgressIndicator = vi.fn();
  ProgressIndicator.prototype.stop = vi.fn();
  return { ProgressIndicator };
});
vi.mock('@gaunt-sloth/review/modules/reviewModule.js', () => ({ review: reviewMock }));
vi.mock('@gaunt-sloth/review/modules/reviewFailureReport.js', () => ({
  writeReviewFailureReport: writeFailureReportMock,
}));
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers: vi.fn() }));

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
  repo = mkdtempSync(join(tmpdir(), 'gsloth-cfg79-app-'));
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
  writeFileSync(join(repo, 'shared.txt'), 'shared line\nlocal edit\n');
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

async function runReview(mergeBase: string, argv: string[] = []): Promise<void> {
  initConfigMock.mockResolvedValue({
    contentSource: 'git',
    writeOutputToFile: false,
    commands: { review: { contentSource: 'git' } },
    contentSourceConfig: { git: { mergeBase } },
  });
  const { reviewCommand } = await import('#src/commands/reviewCommand.js');
  const program = new Command();
  reviewCommand(program, {});
  await program.parseAsync(['na', 'na', 'review', ...argv]);
}

describe('CFG-79 gth review with contentSourceConfig.git.mergeBase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getStringFromStdinMock.mockReturnValue('');
    llmUtilsMock.readBackstory.mockReturnValue('BACKSTORY');
    llmUtilsMock.readGuidelines.mockReturnValue('GUIDELINES');
    llmUtilsMock.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    llmUtilsMock.readSystemPrompt.mockReturnValue('');
  });

  it('reviews the branch against its merge base, local edits included', async () => {
    await runReview('main');

    expect(displayErrorMock).not.toHaveBeenCalled();
    expect(reviewMock).toHaveBeenCalledTimes(1);
    const content = reviewMock.mock.calls[0][2] as string;
    expect(content).toContain('Local git diff against the merge base of "main" and HEAD');
    expect(content).toContain('+feature work');
    expect(content).toContain('+local edit');
    expect(content).not.toContain('upstream.txt');
  });

  it('fails naming the setting and runs no review when the base is unknown', async () => {
    await runReview('no-such-branch');

    expect(reviewMock).not.toHaveBeenCalled();
    expect(setExitCodeMock).toHaveBeenCalledWith(1);
    expect(displayErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('contentSourceConfig.git.mergeBase "no-such-branch"')
    );
  });

  it('fails naming the setting and runs no review when the base starts with -', async () => {
    await runReview('--output=pwned');

    expect(reviewMock).not.toHaveBeenCalled();
    expect(setExitCodeMock).toHaveBeenCalledWith(1);
    expect(displayErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Invalid contentSourceConfig.git.mergeBase "--output=pwned"')
    );
  });

  it('keeps an explicit contentId over the setting', async () => {
    await runReview('main', ['main']);

    expect(reviewMock).toHaveBeenCalledTimes(1);
    const content = reviewMock.mock.calls[0][2] as string;
    expect(content).toContain('Local git diff for "main"');
    expect(content).toContain('upstream.txt');
  });
});
