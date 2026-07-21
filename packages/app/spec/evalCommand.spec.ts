import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Make randomUUID deterministic across this spec (used by wrapContent block ids)
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
  };
});

const resolversMock = {
  createResolvers: vi.fn(),
};
vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

const resolvedFactory = vi.fn();
const resolveAgentFactoryMock = {
  resolveAgentFactory: vi.fn(() => resolvedFactory),
};
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => resolveAgentFactoryMock);

const runSingleShot = vi.fn();
vi.mock('@gaunt-sloth/core/runtime/singleShot.js', () => ({ runSingleShot }));

// BATCH-12 Task 2: the MULTI-TURN conversational runner the eval command wires for `turns:` cases.
const runConversation = vi.fn();
vi.mock('@gaunt-sloth/core/runtime/conversation.js', () => ({ runConversation }));

// BATCH-14: the ADK (A2A) target's runner builders — mocked so the command's target-type dispatch is
// tested without touching the real A2A client (the runner logic itself is covered in adkEvalRunner.spec).
const adkRunnerMock = {
  buildAdkRunCell: vi.fn(),
  buildAdkRunConversation: vi.fn(),
};
vi.mock('#src/commands/adkEvalRunner.js', () => adkRunnerMock);

// BATCH-15: the AG-UI target's runner builders — mocked so the command's target-type dispatch is
// tested without touching the real HTTP/SSE client (the runner logic is covered in agUiEvalRunner.spec).
const agUiRunnerMock = {
  buildAgUiRunCell: vi.fn(),
  buildAgUiRunConversation: vi.fn(),
};
vi.mock('#src/commands/agUiEvalRunner.js', () => agUiRunnerMock);

const prompt = {
  readExecPrompt: vi.fn(),
  readBackstory: vi.fn(),
  readGuidelines: vi.fn(),
  readSystemPrompt: vi.fn(),
  buildSystemMessages: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async () => {
  const actual = await vi.importActual<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>(
    '@gaunt-sloth/core/utils/llmUtils.js'
  );
  return {
    ...actual,
    readExecPrompt: prompt.readExecPrompt,
    readBackstory: prompt.readBackstory,
    readGuidelines: prompt.readGuidelines,
    readSystemPrompt: prompt.readSystemPrompt,
    buildSystemMessages: prompt.buildSystemMessages,
  };
});

// A safe (non-root, cleaned-up-per-test) stand-in for where getGslothFilePath would place a
// default-named report/dir in a real project.
const defaultOutputRoot = join(tmpdir(), 'gth-eval-command-default-output');

const fileUtilsMock = {
  readFileFromProjectDir: vi.fn(),
  getGslothFilePath: vi.fn((name: string) => join(defaultOutputRoot, name)),
  fileSafeLocalDate: vi.fn(() => '2026-07-18_00-00-00'),
  // BATCH-19: loads a config-declared custom reporter module. Real implementation supplied by the
  // config-reporter test; never called by tests that don't set `config.reporters`.
  importExternalFile: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => fileUtilsMock);

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  setExitCode: vi.fn(),
  // BATCH-19: the project-dir base a config-relative reporter module path resolves against.
  getProjectDir: vi.fn(() => process.cwd()),
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

// The judge model: `withStructuredOutput` defaults to a high-rate PASS so tests that don't care
// about judge grading (checks-only cases) never need to think about it. Individual tests override
// this per case via a fresh `structuredInvoke` implementation.
const structuredInvoke = vi.fn(async () => ({ rate: 9, reason: 'Good answer.' }));
const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));

const mockConfig = {
  llm: { invoke: vi.fn(), model: 'base-model', withStructuredOutput },
  projectGuidelines: '.gsloth.guidelines.md',
  streamOutput: true,
  writeOutputToFile: true,
  canInterruptInferenceWithEsc: true,
  commands: { exec: { filesystem: 'all' } },
};

const configMock = {
  initConfig: vi.fn(),
  // GS2-62: the pure judge-profile pre-check. Defaulted truthy in beforeEach so existing judge
  // tests clear the pre-check; the missing-profile test overrides it to undefined.
  resolveIdentityProfileConfigPath: vi.fn(),
};
vi.mock('@gaunt-sloth/core/config.js', () => configMock);

const SIMPLE_SUITE = `
target: { type: gth-agent }
cases:
  - id: greets-politely
    prompt: "greet the user"
    must_contain: ["hello"]
`;

const JUDGE_SUITE = `
target: { type: gth-agent }
defaults: { pass_threshold: 6 }
cases:
  - id: judged-case
    prompt: "explain the thing"
    judge: "Explains clearly."
`;

// BATCH-10 Task 2: a judged suite that also declares a suite-level judge_profile.
const JUDGE_PROFILE_SUITE = `
target: { type: gth-agent }
judge_profile: suite-judge
defaults: { pass_threshold: 6 }
cases:
  - id: judged-case
    prompt: "explain the thing"
    judge: "Explains clearly."
`;

describe('evalCommand', () => {
  let outputDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();

    outputDir = mkdtempSync(join(tmpdir(), 'gth-eval-command-'));

    configMock.initConfig.mockResolvedValue({ ...mockConfig, llm: { ...mockConfig.llm } });
    // GS2-62: default the judge-profile pre-check to "resolves" so a --judge/judge_profile test
    // reaches the judge build; the missing-profile test overrides this to undefined.
    configMock.resolveIdentityProfileConfigPath.mockReturnValue(
      '/mock/.gsloth/.gsloth-settings/judge/.gsloth.config.json'
    );
    runSingleShot.mockResolvedValue({
      ok: true,
      answer: 'hello there',
      tokensInput: 12,
      tokensOutput: 34,
      tools: ['read_file'],
    });
    resolversMock.createResolvers.mockImplementation(() => ({
      resolveTools: vi.fn(),
      cleanupTools: vi.fn(),
    }));
    // BATCH-14: default ADK runner builders — a passing single-shot cell + an empty conversation.
    // Only exercised by the adk-agent suite (the command imports this module only for that target).
    adkRunnerMock.buildAdkRunCell.mockReturnValue(async () => ({
      ok: true,
      answer: 'hello there',
    }));
    adkRunnerMock.buildAdkRunConversation.mockReturnValue(async () => []);
    // BATCH-15: default AG-UI runner builders — a passing single-shot cell that also carries a tool
    // trace (only exercised by the ag-ui suite). Tools present proves the command surfaces them.
    agUiRunnerMock.buildAgUiRunCell.mockReturnValue(async () => ({
      ok: true,
      answer: 'hello there',
      tools: ['get_weather'],
    }));
    agUiRunnerMock.buildAgUiRunConversation.mockReturnValue(async () => []);
    structuredInvoke.mockResolvedValue({ rate: 9, reason: 'Good answer.' });

    prompt.readSystemPrompt.mockReturnValue('');
    prompt.readBackstory.mockReturnValue('BACKSTORY');
    prompt.readGuidelines.mockReturnValue('GUIDELINES');
    prompt.buildSystemMessages.mockReturnValue([{ content: 'ASK SYSTEM PROMPT' }]);

    fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
      if (file === 'suite.yaml') return SIMPLE_SUITE;
      if (file === 'judge-suite.yaml') return JUDGE_SUITE;
      if (file === 'judge-profile-suite.yaml') return JUDGE_PROFILE_SUITE;
      throw new Error(`unexpected file read: ${file}`);
    });
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(defaultOutputRoot, { recursive: true, force: true });
  });

  it('registers the eval command with a description', async () => {
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    expect(program.commands[0].name()).toEqual('eval');
    expect(program.commands[0].description()).toContain('judge');
  });

  it('runs a checks-only case through runSingleShot in ask mode and exits 0 on PASS', async () => {
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

    expect(runSingleShot).toHaveBeenCalledTimes(1);
    const [source, preamble, content, config, , command, agentFactory] =
      runSingleShot.mock.calls[0];
    expect(source).toEqual('EVAL-greets-politely');
    expect(preamble).toEqual('BACKSTORY\nGUIDELINES');
    expect(content).toContain('greet the user');
    expect(command).toEqual('ask');
    expect(config.writeOutputToFile).toBe(false);
    expect(agentFactory).toBe(resolvedFactory);

    expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();

    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson).toMatchObject({ total: 1, passed: 1, failed: 0 });

    const caseJson = JSON.parse(readFileSync(join(outputDir, 'greets-politely.json'), 'utf8'));
    expect(caseJson).toMatchObject({
      id: 'greets-politely',
      verdict: 'PASS',
      answer: 'hello there',
      tokensInput: 12,
      tokensOutput: 34,
      tools: ['read_file'],
    });

    expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets-politely');
    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      expect.stringContaining('EVAL RESULT: 1/1 case(s) passed')
    );
  });

  it('sets a non-zero exit code when a case FAILs its deterministic checks', async () => {
    runSingleShot.mockResolvedValue({ ok: true, answer: 'goodbye only', tools: [] });
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('FAIL  greets-politely')
    );
  });

  it('grades a judge-rubric case via config.llm.withStructuredOutput and PASSes at/above threshold', async () => {
    runSingleShot.mockResolvedValue({ ok: true, answer: 'a clear explanation', tools: [] });
    structuredInvoke.mockResolvedValue({ rate: 8, reason: 'Clear and correct.' });

    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'judge-suite.yaml', '-o', outputDir]);

    expect(withStructuredOutput).toHaveBeenCalledOnce();
    expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    const caseJson = JSON.parse(readFileSync(join(outputDir, 'judged-case.json'), 'utf8'));
    expect(caseJson).toMatchObject({
      verdict: 'PASS',
      judge: { attempted: true, ok: true, verdict: { rate: 8, reason: 'Clear and correct.' } },
    });
  });

  it('FAILs a judge-rubric case below threshold and sets a non-zero exit code', async () => {
    runSingleShot.mockResolvedValue({ ok: true, answer: 'a confusing mess', tools: [] });
    structuredInvoke.mockResolvedValue({ rate: 2, reason: 'Unclear.' });

    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'judge-suite.yaml', '-o', outputDir]);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson.cases[0].reasons).toEqual(['judge rate 2/10 below threshold 6: Unclear.']);
  });

  it('FAILs the case (without crashing) when the judge call throws', async () => {
    runSingleShot.mockResolvedValue({ ok: true, answer: 'anything', tools: [] });
    structuredInvoke.mockRejectedValue(new Error('judge model unavailable'));

    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'judge-suite.yaml', '-o', outputDir]);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson.cases[0].judge).toMatchObject({
      ok: false,
      error: 'judge model unavailable',
    });
  });

  it('exits 2 (harness error, no throw) when the suite file is malformed', async () => {
    // BATCH-11: a malformed suite is a harness error, not a product regression — the action catches
    // it, reports it, and sets exit 2 (distinct from a suite-fail exit 1) rather than letting it
    // surface as a generic exit 1 via the entry point. parseAsync therefore resolves normally.
    fileUtilsMock.readFileFromProjectDir.mockImplementation(() => 'not: [valid yaml');
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});

    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
    expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse eval suite YAML')
    );
    expect(runSingleShot).not.toHaveBeenCalled();
  });

  it('exits 2 (harness error) when config fails to build', async () => {
    // BATCH-11: a config/provider failure means the SUT can't run at all — an environment signal.
    configMock.initConfig.mockRejectedValue(new Error('provider not configured'));
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});

    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
    expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
      expect.stringContaining('provider not configured')
    );
    expect(runSingleShot).not.toHaveBeenCalled();
  });

  it('exits 2 (harness error) when EVERY case fails its SUT run — no gradeable results', async () => {
    // BATCH-11: all cases sutOk:false (e.g. a transport/auth failure) = "couldn't produce gradeable
    // results" = exit 2, distinct from a product regression (exit 1).
    runSingleShot.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED' });
    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});

    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

    expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
    const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    expect(resultsJson.cases.every((c: { sutOk: boolean }) => c.sutOk === false)).toBe(true);
  });

  it('respects -j/--concurrency pass-through to the eval runner', async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    fileUtilsMock.readFileFromProjectDir.mockImplementation(
      () => `
target: { type: gth-agent }
cases:
  - id: c0
    prompt: "p0"
    must_contain: ["ok"]
  - id: c1
    prompt: "p1"
    must_contain: ["ok"]
  - id: c2
    prompt: "p2"
    must_contain: ["ok"]
  - id: c3
    prompt: "p3"
    must_contain: ["ok"]
`
    );
    runSingleShot.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, answer: 'ok', tools: [] };
    });

    const { evalCommand } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-j', '2', '-o', outputDir]);

    expect(maxInFlight).toBe(2);
  });

  it('uses the default timestamped output dir when -o is omitted', async () => {
    const { evalCommand, defaultEvalOutputDir } = await import('#src/commands/evalCommand.js');
    const program = new Command();
    evalCommand(program, {});
    await program.parseAsync(['na', 'na', 'eval', 'suite.yaml']);

    expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
      expect.stringContaining(defaultEvalOutputDir())
    );
  });

  // BATCH-10 Task 2: the judge can run under a separate identity profile than the SUT.
  describe('separate judge profile (--judge / suite judge_profile)', () => {
    // Build a config-per-profile resolver: initConfig returns a judge-specific config (its own
    // `withStructuredOutput` spy) when asked for a given identityProfile, else the default SUT
    // config. Returns the judge's structured-output spy so a test can assert the judge graded via
    // the judge profile's llm and NOT the SUT's.
    function stubJudgeProfile(profileName: string, judgeRate = 9) {
      const judgeStructuredInvoke = vi.fn(async () => ({
        rate: judgeRate,
        reason: 'Judged by the separate profile model.',
      }));
      const judgeWithStructuredOutput = vi.fn(() => ({ invoke: judgeStructuredInvoke }));
      configMock.initConfig.mockImplementation(async (overrides?: { identityProfile?: string }) => {
        if (overrides?.identityProfile === profileName) {
          return {
            ...mockConfig,
            llm: {
              ...mockConfig.llm,
              model: 'judge-model',
              withStructuredOutput: judgeWithStructuredOutput,
            },
          };
        }
        return { ...mockConfig, llm: { ...mockConfig.llm } };
      });
      return { judgeWithStructuredOutput, judgeStructuredInvoke };
    }

    it('builds the judge from the --judge profile config, not the SUT config', async () => {
      runSingleShot.mockResolvedValue({ ok: true, answer: 'a clear explanation', tools: [] });
      const { judgeWithStructuredOutput } = stubJudgeProfile('strict-judge');

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'judge-suite.yaml',
        '--judge',
        'strict-judge',
        '-o',
        outputDir,
      ]);

      // A separate config was built for the judge profile...
      expect(configMock.initConfig).toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'strict-judge' })
      );
      // ...and the judge graded via THAT config's llm, never the SUT's.
      expect(judgeWithStructuredOutput).toHaveBeenCalledOnce();
      expect(withStructuredOutput).not.toHaveBeenCalled();

      // The run is self-describing: a single line naming the judge profile + model.
      expect(consoleUtilsMock.display).toHaveBeenCalledWith(
        expect.stringContaining('strict-judge')
      );
      expect(consoleUtilsMock.display).toHaveBeenCalledWith(expect.stringContaining('judge-model'));

      const caseJson = JSON.parse(readFileSync(join(outputDir, 'judged-case.json'), 'utf8'));
      expect(caseJson).toMatchObject({
        verdict: 'PASS',
        judge: { attempted: true, ok: true, verdict: { rate: 9 } },
      });
    });

    it('lets CLI --judge override the suite-level judge_profile', async () => {
      runSingleShot.mockResolvedValue({ ok: true, answer: 'a clear explanation', tools: [] });
      const { judgeWithStructuredOutput } = stubJudgeProfile('cli-judge');

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'judge-profile-suite.yaml', // declares judge_profile: suite-judge
        '--judge',
        'cli-judge',
        '-o',
        outputDir,
      ]);

      // CLI wins: config built for cli-judge, never for the suite's suite-judge.
      expect(configMock.initConfig).toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'cli-judge' })
      );
      expect(configMock.initConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'suite-judge' })
      );
      expect(judgeWithStructuredOutput).toHaveBeenCalledOnce();
      expect(withStructuredOutput).not.toHaveBeenCalled();
    });

    it('falls back to the suite judge_profile when --judge is omitted', async () => {
      runSingleShot.mockResolvedValue({ ok: true, answer: 'a clear explanation', tools: [] });
      const { judgeWithStructuredOutput } = stubJudgeProfile('suite-judge');

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'judge-profile-suite.yaml', // declares judge_profile: suite-judge
        '-o',
        outputDir,
      ]);

      expect(configMock.initConfig).toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'suite-judge' })
      );
      expect(judgeWithStructuredOutput).toHaveBeenCalledOnce();
      expect(withStructuredOutput).not.toHaveBeenCalled();
    });

    it('surfaces a judge profile that fails to load as a harness error (exit 2)', async () => {
      // A bad --judge profile makes the judge initConfig reject; the outer catch turns it into the
      // exit-2 harness signal (not a product-regression exit 1).
      configMock.initConfig.mockImplementation(async (overrides?: { identityProfile?: string }) => {
        if (overrides?.identityProfile === 'no-such-profile') {
          throw new Error('profile "no-such-profile" not found');
        }
        return { ...mockConfig, llm: { ...mockConfig.llm } };
      });

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'judge-suite.yaml',
        '--judge',
        'no-such-profile',
        '-o',
        outputDir,
      ]);

      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('no-such-profile')
      );
    });

    it('GS2-62: a --judge profile with no config is pre-checked → exit 2, WITHOUT calling initConfig for it', async () => {
      // The PURE pre-check (resolveIdentityProfileConfigPath) reports the profile has no config, so
      // eval throws its OWN catchable error → exit 2, instead of handing the bad profile to
      // initConfig, whose uncatchable exit(1) would end the process with the wrong code and collapse
      // the harness-vs-product (2-vs-1) distinction. The misleading `Judge: profile "…"` line never
      // prints, and the run never reaches the SUT.
      runSingleShot.mockResolvedValue({ ok: true, answer: 'a clear explanation', tools: [] });
      configMock.resolveIdentityProfileConfigPath.mockReturnValue(undefined);

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'judge-suite.yaml',
        '--judge',
        'typo',
        '-o',
        outputDir,
      ]);

      expect(configMock.resolveIdentityProfileConfigPath).toHaveBeenCalledWith('typo');
      // Never handed the bad judge profile to initConfig (whose failure path can hard exit(1)).
      expect(configMock.initConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'typo' })
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('judge profile "typo" not found')
      );
      // The self-describing judge notice must NOT print for a profile that never resolved.
      expect(consoleUtilsMock.display).not.toHaveBeenCalledWith(expect.stringContaining('Judge:'));
    });

    it('does NOT build a separate judge config or print a judge line when no profile is set', async () => {
      // Regression guard: the default (no --judge, no suite judge_profile) path is unchanged —
      // initConfig is called exactly once (the SUT), and no self-describing judge line is printed.
      runSingleShot.mockResolvedValue({ ok: true, answer: 'a clear explanation', tools: [] });

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'judge-suite.yaml', '-o', outputDir]);

      expect(configMock.initConfig).toHaveBeenCalledTimes(1);
      expect(configMock.initConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: expect.anything() })
      );
      expect(consoleUtilsMock.display).not.toHaveBeenCalledWith(expect.stringContaining('Judge:'));
    });
  });

  // BATCH-12 (#405 his #1): the identity matrix — run each case once per suite `identities` entry,
  // each under its own `initConfig({ …, identityProfile })`, with a resolve-precondition before any
  // run. Unit-tested with FAKES (mocked runSingleShot / initConfig / resolveIdentityProfileConfigPath)
  // — there is no live multi-identity MCP here, so the real authorization scenario is unverified.
  describe('identity matrix (--identities via suite `identities`)', () => {
    const MATRIX_SUITE = `
target: { type: gth-agent }
identities: [admin, limited]
cases:
  - id: greets
    prompt: "greet the user"
    expect:
      - identities: [admin]
        must_contain: ["hello"]
      - identities: [limited]
        must_contain: ["hello"]
`;

    it('runs one cell per (case × identity), each under its own identityProfile config, writing per-identity output', async () => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation(() => MATRIX_SUITE);
      runSingleShot.mockResolvedValue({ ok: true, answer: 'hello there', tools: [] });

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'matrix.yaml', '-o', outputDir]);

      // Precondition ran for each declared identity...
      expect(configMock.resolveIdentityProfileConfigPath).toHaveBeenCalledWith('admin');
      expect(configMock.resolveIdentityProfileConfigPath).toHaveBeenCalledWith('limited');
      // ...and a SEPARATE config was built per identity (mirrors `gth batch --models`).
      expect(configMock.initConfig).toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'admin' })
      );
      expect(configMock.initConfig).toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'limited' })
      );
      // Two cells → two SUT runs, named with the composite cell id.
      expect(runSingleShot).toHaveBeenCalledTimes(2);
      const sources = runSingleShot.mock.calls.map((c) => c[0]);
      expect(sources).toEqual(
        expect.arrayContaining(['EVAL-greets__admin', 'EVAL-greets__limited'])
      );

      // Per-identity output files, each carrying its identity.
      const adminJson = JSON.parse(readFileSync(join(outputDir, 'greets__admin.json'), 'utf8'));
      const limitedJson = JSON.parse(readFileSync(join(outputDir, 'greets__limited.json'), 'utf8'));
      expect(adminJson).toMatchObject({ id: 'greets', identity: 'admin', verdict: 'PASS' });
      expect(limitedJson).toMatchObject({ id: 'greets', identity: 'limited', verdict: 'PASS' });

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson).toMatchObject({ total: 2, passed: 2, failed: 0 });

      // Summary lines tag each cell with its identity; exit 0 on all-pass.
      expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets [admin]');
      expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets [limited]');
      // M1: a matrix run counts CELLS, so the verdict noun is "cell(s)", not "case(s)".
      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
        expect.stringContaining('EVAL RESULT: 2/2 cell(s) passed')
      );
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('PRECONDITION: an unresolved identity → exit 2, names it, and runs NOTHING', async () => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation(() => MATRIX_SUITE);
      // `limited` has no config of its own; `admin` resolves.
      configMock.resolveIdentityProfileConfigPath.mockImplementation((name: string) =>
        name === 'limited' ? undefined : '/mock/.gsloth/.gsloth-settings/admin/.gsloth.config.json'
      );

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'matrix.yaml', '-o', outputDir]);

      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('limited')
      );
      // Guard is BEFORE any per-identity initConfig (a bad profile reaching initConfig hits its
      // uncatchable exit(1)) — so no per-identity config is built and no case runs.
      expect(configMock.initConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'limited' })
      );
      expect(configMock.initConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ identityProfile: 'admin' })
      );
      expect(runSingleShot).not.toHaveBeenCalled();
    });

    it('reports a product regression (exit 1) when one identity cell fails its block', async () => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation(() => MATRIX_SUITE);
      // Both identities get the same answer; neither contains "hello" → both cells FAIL.
      runSingleShot.mockResolvedValue({ ok: true, answer: 'goodbye', tools: [] });

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'matrix.yaml', '-o', outputDir]);

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson).toMatchObject({ total: 2, passed: 0, failed: 2 });
      // sutOk:true (ran, produced answers) but failed checks → product regression, exit 1.
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('FAIL  greets [admin]')
      );
    });
  });

  // BATCH-12 Task 2 (#405 multi-turn): a `turns:` case is ONE conversation, routed through
  // `runConversation` (not `runSingleShot`), graded turn-by-turn. Unit-tested with a FAKE
  // `runConversation` (mocked module) — no live MCP/conversation here, so cross-turn memory /
  // authorization is unverified pending the reporter's live pass.
  describe('multi-turn cases (turns:)', () => {
    const MULTI_TURN_SUITE = `
target: { type: gth-agent }
cases:
  - id: remembers
    turns:
      - user: "what contract types exist?"
        must_contain: ["contract"]
      - user: "how many did you just list?"
        must_match: ["\\\\b\\\\d+\\\\b"]
`;

    beforeEach(() => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
        if (file === 'multi.yaml') return MULTI_TURN_SUITE;
        throw new Error(`unexpected file read: ${file}`);
      });
    });

    it('routes a turns: case through runConversation (once), grades each turn, exits 0 on all-pass', async () => {
      const cleanupTools = vi.fn();
      resolversMock.createResolvers.mockReturnValue({ resolveTools: vi.fn(), cleanupTools });
      runConversation.mockResolvedValue([
        { ok: true, answer: 'the contract types are A and B', tools: ['mcp__x'] },
        { ok: true, answer: 'there are 2 of them', tools: [] },
      ]);

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'multi.yaml', '-o', outputDir]);

      // The multi-turn case did NOT touch the single-turn path; the whole conversation ran ONCE.
      expect(runSingleShot).not.toHaveBeenCalled();
      expect(runConversation).toHaveBeenCalledTimes(1);
      const [, , userMessages, config, , command, agentFactory] = runConversation.mock.calls[0];
      expect(command).toBe('ask');
      expect(config.writeOutputToFile).toBe(false);
      expect(agentFactory).toBe(resolvedFactory);
      // Both user messages handed to the one conversation, in order (wrapped).
      expect(userMessages).toHaveLength(2);
      expect(userMessages[0]).toContain('what contract types exist?');
      expect(userMessages[1]).toContain('how many did you just list?');

      // Fresh resolvers created once for the conversation and cleaned up ONCE (no per-turn leak).
      expect(resolversMock.createResolvers).toHaveBeenCalledTimes(1);
      expect(cleanupTools).toHaveBeenCalledTimes(1);

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson).toMatchObject({ total: 1, passed: 1, failed: 0 });
      const caseJson = JSON.parse(readFileSync(join(outputDir, 'remembers.json'), 'utf8'));
      expect(caseJson).toMatchObject({ id: 'remembers', verdict: 'PASS' });
      expect(caseJson.turns).toHaveLength(2);
      expect(caseJson.turns[0].verdict).toBe('PASS');
      expect(caseJson.turns[1].verdict).toBe('PASS');
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('exits 1 and names the failing turn when a later turn in the conversation FAILs', async () => {
      resolversMock.createResolvers.mockReturnValue({
        resolveTools: vi.fn(),
        cleanupTools: vi.fn(),
      });
      runConversation.mockResolvedValue([
        { ok: true, answer: 'the contract types are A and B' }, // turn 1 PASS (has "contract")
        { ok: true, answer: 'quite a few' }, // turn 2 FAIL (no digit)
      ]);

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'multi.yaml', '-o', outputDir]);

      const caseJson = JSON.parse(readFileSync(join(outputDir, 'remembers.json'), 'utf8'));
      expect(caseJson.verdict).toBe('FAIL');
      expect(caseJson.turns[0].verdict).toBe('PASS');
      expect(caseJson.turns[1].verdict).toBe('FAIL');
      expect(caseJson.reasons.some((r: string) => r.startsWith('turn 2:'))).toBe(true);
      // sutOk:true (both turns ran) with a failing turn → product regression, exit 1.
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('FAIL  remembers')
      );
    });
  });

  // BATCH-14: an `adk-agent` suite drives the ADK (A2A) runner, NOT the in-process gth `runSingleShot`
  // path. Here the ADK runner builders are mocked (their logic is covered end-to-end in
  // adkEvalRunner.spec); this test proves the command's target-type DISPATCH + grading of the answer.
  describe('adk-agent target (BATCH-14)', () => {
    const ADK_SUITE = `
target: { type: adk-agent, url: "http://localhost:8080", agent_id: my-adk }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
`;

    beforeEach(() => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
        if (file === 'adk.yaml') return ADK_SUITE;
        throw new Error(`unexpected file read: ${file}`);
      });
    });

    it('dispatches to the ADK runner (not runSingleShot) and grades the A2A answer, exit 0 on PASS', async () => {
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'adk.yaml', '-o', outputDir]);

      // Wired to the ADK builders with the parsed adk-agent target...
      expect(adkRunnerMock.buildAdkRunCell).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'adk-agent',
          url: 'http://localhost:8080',
          agentId: 'my-adk',
        })
      );
      expect(adkRunnerMock.buildAdkRunConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'adk-agent', url: 'http://localhost:8080' })
      );
      // ...and NOT the in-process gth-agent path.
      expect(runSingleShot).not.toHaveBeenCalled();
      expect(resolversMock.createResolvers).not.toHaveBeenCalled();

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson).toMatchObject({ total: 1, passed: 1, failed: 0 });
      const caseJson = JSON.parse(readFileSync(join(outputDir, 'greets.json'), 'utf8'));
      expect(caseJson).toMatchObject({ id: 'greets', verdict: 'PASS', answer: 'hello there' });
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('exits 2 (harness error) for an adk-agent suite missing its url — nothing runs', async () => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation(
        () => `
target: { type: adk-agent }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
`
      );
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'adk.yaml', '-o', outputDir]);

      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('requires a `url`')
      );
      expect(adkRunnerMock.buildAdkRunCell).not.toHaveBeenCalled();
    });
  });

  // BATCH-15: an `ag-ui` suite drives the AG-UI (HTTP/SSE) runner, NOT the in-process gth
  // `runSingleShot` path. The AG-UI runner builders are mocked (their logic is covered end-to-end in
  // agUiEvalRunner.spec); this test proves the command's target-type DISPATCH + grading of the answer
  // AND the captured tool trace (must_call), the key difference from adk-agent.
  describe('ag-ui target (BATCH-15)', () => {
    const AGUI_SUITE = `
target: { type: ag-ui, url: "http://localhost:3000", agent_id: gth }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
    must_call: ["get_weather"]
`;

    beforeEach(() => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation((file: string) => {
        if (file === 'agui.yaml') return AGUI_SUITE;
        throw new Error(`unexpected file read: ${file}`);
      });
    });

    it('dispatches to the AG-UI runner (not runSingleShot), grades the answer + tool trace, exit 0 on PASS', async () => {
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'agui.yaml', '-o', outputDir]);

      // Wired to the AG-UI builders with the parsed ag-ui target...
      expect(agUiRunnerMock.buildAgUiRunCell).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ag-ui',
          url: 'http://localhost:3000',
          agentId: 'gth',
        })
      );
      expect(agUiRunnerMock.buildAgUiRunConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ag-ui', url: 'http://localhost:3000', agentId: 'gth' })
      );
      // ...and NOT the in-process gth-agent path or the ADK path.
      expect(runSingleShot).not.toHaveBeenCalled();
      expect(resolversMock.createResolvers).not.toHaveBeenCalled();
      expect(adkRunnerMock.buildAdkRunCell).not.toHaveBeenCalled();

      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson).toMatchObject({ total: 1, passed: 1, failed: 0 });
      const caseJson = JSON.parse(readFileSync(join(outputDir, 'greets.json'), 'utf8'));
      // The captured tool trace made `must_call: [get_weather]` PASS (not a silent pass — the tool
      // name is present in the output).
      expect(caseJson).toMatchObject({
        id: 'greets',
        verdict: 'PASS',
        answer: 'hello there',
        tools: ['get_weather'],
      });
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('exits 2 (harness error) for an ag-ui suite missing its agent_id — nothing runs', async () => {
      fileUtilsMock.readFileFromProjectDir.mockImplementation(
        () => `
target: { type: ag-ui, url: "http://localhost:3000" }
cases:
  - id: greets
    prompt: "greet the user"
    must_contain: ["hello"]
`
      );
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'agui.yaml', '-o', outputDir]);

      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('requires an `agent_id`')
      );
      expect(agUiRunnerMock.buildAgUiRunCell).not.toHaveBeenCalled();
    });
  });

  // BATCH-19 A2/A3: `--reporter` selection, the bundled JUnit reporter, and config-declared custom
  // reporters. The always-on results.json + per-cell JSON are unchanged; reporters render IN ADDITION.
  describe('reporter selection (--reporter / config.reporters)', () => {
    it('default (no --reporter) prints the text summary + writes results.json, but NO results.xml', async () => {
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

      expect(existsSync(join(outputDir, 'results.json'))).toBe(true);
      expect(existsSync(join(outputDir, 'results.xml'))).toBe(false);
      expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets-politely');
    });

    it('--reporter junit writes results.xml IN ADDITION to the always-on results.json (JUnit only, no text)', async () => {
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'suite.yaml',
        '-o',
        outputDir,
        '--reporter',
        'junit',
      ]);

      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();

      // Always-on JSON is still written.
      const resultsJson = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
      expect(resultsJson).toMatchObject({ total: 1, passed: 1, failed: 0 });

      // The JUnit reporter added results.xml (suite stem = basename('suite.yaml') sans ext).
      const xml = readFileSync(join(outputDir, 'results.xml'), 'utf8');
      expect(xml).toContain('<?xml');
      expect(xml).toContain('<testsuites name="suite"');
      expect(xml).toContain('classname="suite" name="greets-politely"');

      // --reporter REPLACES the default set, so `junit` alone silences the text reporter.
      expect(consoleUtilsMock.display).not.toHaveBeenCalledWith('PASS  greets-politely');
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalledWith(
        expect.stringContaining('EVAL RESULT')
      );
    });

    it('--reporter text,junit runs BOTH (text summary + results.xml)', async () => {
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'suite.yaml',
        '-o',
        outputDir,
        '--reporter',
        'text,junit',
      ]);

      expect(existsSync(join(outputDir, 'results.xml'))).toBe(true);
      expect(consoleUtilsMock.display).toHaveBeenCalledWith('PASS  greets-politely');
    });

    it('an unknown --reporter name exits 2 (harness error) naming the available reporters, running NOTHING', async () => {
      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'suite.yaml',
        '-o',
        outputDir,
        '--reporter',
        'bogus',
      ]);

      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      // Fail-fast: nothing ran and no partial output was written.
      expect(runSingleShot).not.toHaveBeenCalled();
      expect(existsSync(join(outputDir, 'results.json'))).toBe(false);
      expect(existsSync(join(outputDir, 'results.xml'))).toBe(false);
      // The message quotes the bad name and lists the available reporters (text + bundled junit).
      const errorArgs = consoleUtilsMock.displayError.mock.calls.map((c) => c[0]).join('\n');
      expect(errorArgs).toContain('unknown reporter "bogus"');
      expect(errorArgs).toContain('text');
      expect(errorArgs).toContain('junit');
    });

    it('drives a config-declared custom reporter over the same seam (config.reporters + --reporter mine)', async () => {
      const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
      // The module path is RESOLVED RELATIVE TO THE PROJECT DIR — set the project dir to the
      // fixtures dir and reference the module by a project-relative path.
      systemUtilsMock.getProjectDir.mockReturnValue(fixturesDir);
      fileUtilsMock.importExternalFile.mockImplementation(
        (p: string) => import(pathToFileURL(p).href)
      );
      configMock.initConfig.mockResolvedValue({
        ...mockConfig,
        llm: { ...mockConfig.llm },
        reporters: { mine: './customEvalReporter.mjs' },
      });

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync([
        'na',
        'na',
        'eval',
        'suite.yaml',
        '-o',
        outputDir,
        '--reporter',
        'mine',
      ]);

      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
      // Always-on JSON still written.
      expect(existsSync(join(outputDir, 'results.json'))).toBe(true);
      // The config reporter registered and was driven over the run's cells (proof it saw them).
      const marker = JSON.parse(readFileSync(join(outputDir, 'mine-reporter.json'), 'utf8'));
      expect(marker).toEqual({ observed: ['greets-politely'], total: 1 });
      // `mine` alone: no text summary, no JUnit results.xml.
      expect(consoleUtilsMock.display).not.toHaveBeenCalledWith('PASS  greets-politely');
      expect(existsSync(join(outputDir, 'results.xml'))).toBe(false);
    });

    it('a config reporter whose module fails to load is a harness error (exit 2)', async () => {
      systemUtilsMock.getProjectDir.mockReturnValue(process.cwd());
      fileUtilsMock.importExternalFile.mockRejectedValue(new Error('ENOENT: no such file'));
      configMock.initConfig.mockResolvedValue({
        ...mockConfig,
        llm: { ...mockConfig.llm },
        reporters: { broken: './does-not-exist.mjs' },
      });

      const { evalCommand } = await import('#src/commands/evalCommand.js');
      const program = new Command();
      evalCommand(program, {});
      await program.parseAsync(['na', 'na', 'eval', 'suite.yaml', '-o', outputDir]);

      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(2);
      expect(runSingleShot).not.toHaveBeenCalled();
      const errorArgs = consoleUtilsMock.displayError.mock.calls.map((c) => c[0]).join('\n');
      expect(errorArgs).toContain('broken');
    });
  });
});

// BATCH-10 Task 2: the pure judge-profile resolver, unit tested in isolation.
describe('resolveJudgeProfile', () => {
  it('prefers the CLI --judge value over the suite judge_profile', async () => {
    const { resolveJudgeProfile } = await import('#src/commands/evalCommand.js');
    expect(resolveJudgeProfile('cli-judge', 'suite-judge')).toBe('cli-judge');
  });

  it('falls back to the suite judge_profile when no CLI value is given', async () => {
    const { resolveJudgeProfile } = await import('#src/commands/evalCommand.js');
    expect(resolveJudgeProfile(undefined, 'suite-judge')).toBe('suite-judge');
  });

  it('returns undefined (= judge with the SUT model) when neither is set', async () => {
    const { resolveJudgeProfile } = await import('#src/commands/evalCommand.js');
    expect(resolveJudgeProfile(undefined, undefined)).toBeUndefined();
  });

  it('treats a blank/whitespace CLI value as absent and falls through to the suite value', async () => {
    const { resolveJudgeProfile } = await import('#src/commands/evalCommand.js');
    expect(resolveJudgeProfile('   ', 'suite-judge')).toBe('suite-judge');
  });

  it('returns undefined when both values are blank', async () => {
    const { resolveJudgeProfile } = await import('#src/commands/evalCommand.js');
    expect(resolveJudgeProfile('   ', '  ')).toBeUndefined();
  });

  it('trims the resolved profile name', async () => {
    const { resolveJudgeProfile } = await import('#src/commands/evalCommand.js');
    expect(resolveJudgeProfile('  spaced-judge  ', undefined)).toBe('spaced-judge');
  });
});
