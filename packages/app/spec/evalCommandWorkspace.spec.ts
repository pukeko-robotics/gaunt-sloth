import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandRunnerOptions } from '#src/commands/commandEvalRunner.js';

// BATCH-58 — the `gth eval` command's own workspace wiring, driven through the command the way
// evalCommand.spec drives the other targets: the suite directory handed to the parser, the setup
// printout, `--keep-workspaces`, and the two workspace notices. The runner is mocked here; it has
// its own specs (commandWorkspace.spec, commandEvalRunner.spec).

const runnerMock = {
  buildCommandRunCell: vi.fn(),
  loadTranscriptDecoder: vi.fn(),
};
vi.mock('#src/commands/commandEvalRunner.js', () => runnerMock);

const fileUtilsMock = {
  readFileFromProjectDir: vi.fn(),
  getGslothFilePath: vi.fn((name: string) => join(tmpdir(), name)),
  fileSafeLocalDate: vi.fn(() => '2026-11-19_00-00-00'),
  importExternalFile: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => fileUtilsMock);

const consoleUtilsMock = {
  display: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  setExitCode: vi.fn(),
  getProjectDir: vi.fn(),
  getCurrentWorkDir: vi.fn(() => process.cwd()),
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const configMock = {
  initConfig: vi.fn(),
  resolveIdentityProfileConfigPath: vi.fn(),
  loadRunLevelEvalConfig: vi.fn(),
};
vi.mock('@gaunt-sloth/core/config.js', () => configMock);

const SUITE = `
target:
  type: command
  run: claude -p --output-format stream-json --verbose
  transcript: claude-stream-json
defaults:
  workspace:
    template: fixtures/tiny-repo
    setup: ["git init -q", "git add -A"]
cases:
  - id: edits
    prompt: "fix it"
    must_contain: [ok]
    after:
      - { run: "git status --porcelain", equals: "" }
      - { run: "git diff --stat", equals: "" }
  - id: also
    prompt: "again"
    after:
      - { run: "git status --porcelain", equals: "" }
`;

describe('gth eval — command workspace wiring', () => {
  let projectRoot: string;
  let outputDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    // The project directory is NOT the process cwd, so a suite directory resolved against the cwd
    // would look for the template in the wrong place.
    projectRoot = mkdtempSync(join(tmpdir(), 'gth-eval-wiring-project-'));
    mkdirSync(join(projectRoot, 'eval', 'fixtures', 'tiny-repo'), { recursive: true });
    outputDir = mkdtempSync(join(tmpdir(), 'gth-eval-wiring-out-'));
    systemUtilsMock.getProjectDir.mockReturnValue(projectRoot);
    systemUtilsMock.getCurrentWorkDir.mockReturnValue(process.cwd());
    configMock.initConfig.mockResolvedValue({ llm: { invoke: vi.fn(), model: 'm' } });
    configMock.loadRunLevelEvalConfig.mockResolvedValue({ found: true, layer: 'project' });
    fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
      if (file === join('eval', 'suite.yaml')) return SUITE;
      throw new Error(`unexpected file read: ${file}`);
    });
    runnerMock.loadTranscriptDecoder.mockResolvedValue(() => ({
      answer: 'ok',
      toolCalls: [],
      toolResults: [],
    }));
    runnerMock.buildCommandRunCell.mockReturnValue(async () => ({ ok: true, answer: 'ok' }));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });

  async function runEval(...extra: string[]): Promise<CommandRunnerOptions> {
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync([
      'na',
      'na',
      'eval',
      join('eval', 'suite.yaml'),
      '-o',
      outputDir,
      ...extra,
    ]);
    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    expect(runnerMock.buildCommandRunCell).toHaveBeenCalledTimes(1);
    return runnerMock.buildCommandRunCell.mock.calls[0][3] as CommandRunnerOptions;
  }

  it('resolves the template from the suite directory under the project directory', async () => {
    await runEval();
    const suite = runnerMock.buildCommandRunCell.mock.calls[0][1];
    expect(suite.cases[0].workspace.template).toBe(
      resolve(projectRoot, 'eval', 'fixtures', 'tiny-repo')
    );
    expect(suite.cases[0].workspace.suiteDir).toBe(resolve(projectRoot, 'eval'));
  });

  it('prints the setup commands before the run, with the command line', async () => {
    await runEval();
    expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
      `eval: ${join('eval', 'suite.yaml')} first runs these setup commands in each case's ` +
        'workspace, as its workspace declares them: git init -q ; git add -A'
    );
  });

  it('prints the after commands before the run too, each once, and hands them to the runner', async () => {
    await runEval();
    expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
      `eval: ${join('eval', 'suite.yaml')} then runs these after commands in each case's ` +
        'workspace, as its case declares them: git status --porcelain ; git diff --stat'
    );
    const suite = runnerMock.buildCommandRunCell.mock.calls[0][1];
    expect(suite.cases[0].workspaceChecks.after).toHaveLength(2);
  });

  it('passes --keep-workspaces to the runner, and only when given', async () => {
    expect((await runEval()).keepWorkspaces).toBe(false);
    vi.clearAllMocks();
    expect((await runEval('--keep-workspaces')).keepWorkspaces).toBe(true);
  });

  it('prints a kept workspace and warns about one that could not be removed', async () => {
    const options = await runEval('--keep-workspaces');
    options.onWorkspaceKept!('edits', '/kept/dir');
    expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
      'eval: kept the workspace of case "edits": /kept/dir'
    );
    options.onWorkspaceRemoveFailed!('edits', '/busy/dir', 'EBUSY: resource busy');
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      'eval: could not remove the workspace of case "edits" (/busy/dir): EBUSY: resource busy'
    );
  });
});
