import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
