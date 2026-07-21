import { Command } from 'commander';
import {
  CommandLineConfigOverrides,
  initConfig,
  resolveIdentityProfileConfigPath,
} from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getAskSystemPrompt } from '#src/commands/commandIntrospection.js';
import {
  buildProductionRunCell,
  buildProductionRunConversation,
} from '#src/commands/batchCommand.js';
import { parseIntOption } from '#src/commands/cliOptionParsers.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  fileSafeLocalDate,
  getGslothFilePath,
  readFileFromProjectDir,
} from '@gaunt-sloth/core/utils/fileUtils.js';
import type { JudgeFn, RunCellFn, RunConversationFn } from '@gaunt-sloth/batch';

interface EvalCommandOptions {
  /** `-j/--concurrency <n>` — max in-flight cases. */
  concurrency?: number;
  /** `-o/--output <dir>` — where structured per-case + summary output is written. */
  output?: string;
  /** `--judge <profile>` — identity profile whose model judges the cases (BATCH-10 Task 2).
   * Overrides the suite's `judge_profile`; omit to judge with the SUT model. */
  judge?: string;
}

/** Default output dir when `-o/--output` is omitted: a timestamped dir next to other gth reports —
 * same convention as `defaultBatchOutputDir` in `batchCommand.ts`, `_EVAL` suffix instead. */
export function defaultEvalOutputDir(): string {
  return getGslothFilePath(`gth_${fileSafeLocalDate()}_EVAL`);
}

/**
 * Build the production {@link JudgeFn}: grades one case's answer with `judgeEvalCase` against
 * `config.llm`. The caller chooses *which* config this is (BATCH-10 Task 2): by default it's the
 * SUT's own config (judge shares the SUT model, the original behavior), but when a judge identity
 * profile is resolved (`--judge <profile>` or the suite's `judge_profile`) the action passes a
 * *separate* `initConfig({ …, identityProfile })` here, so the judge runs under its own model — a
 * different model can catch blind spots the SUT model shares. This function stays agnostic to that
 * choice; it just grades against whatever `config.llm` it's handed.
 */
function buildProductionJudge(config: GthConfig): JudgeFn {
  return async (answer, rubric) => {
    const { judgeEvalCase } = await import('@gaunt-sloth/batch/judge.js');
    return judgeEvalCase(answer, rubric, config.llm);
  };
}

/**
 * Pure resolver for the judge identity profile — kept small and side-effect-free so it's unit
 * testable in isolation. Precedence (highest first): CLI `--judge <profile>` > suite-level
 * `judge_profile` > none. A blank/whitespace-only value at either level counts as absent (falls
 * through to the next level). `undefined` means "no separate judge — grade with the SUT's config".
 */
export function resolveJudgeProfile(
  cliJudge: string | undefined,
  suiteJudgeProfile: string | undefined
): string | undefined {
  const cli = cliJudge?.trim();
  if (cli) return cli;
  const suite = suiteJudgeProfile?.trim();
  if (suite) return suite;
  return undefined;
}

/** Best-effort model name for the self-describing judge line. `BaseChatModel` doesn't standardize a
 * public model-name field, so read `model` then `modelName`; return `undefined` if neither is a
 * usable string (the profile name alone still describes the run). */
function judgeModelName(config: GthConfig): string | undefined {
  const llm = config.llm as { model?: unknown; modelName?: unknown };
  const name = typeof llm.model === 'string' ? llm.model : llm.modelName;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Adds the `eval` command to the program.
 *
 * `gth eval <suite.yaml> [-j 8] [-o out/]` — grades a suite of cases (deterministic checks and/or
 * an LLM judge) against the SUT agent, the way `review` grades a diff. See
 * docs/batch-eval-cli-surface.md and docs/batch-eval-user-requirements.md for the design; this
 * command implements the single-`prompt`, `gth-agent`-target, `config.llm`-as-judge subset — see
 * the BATCH-2 Task 2 brief's "Not in scope" list for what's deliberately deferred.
 *
 * Exit-code contract (BATCH-11 / #405 his #6 — a distinct three-way code so CI can tell a product
 * regression from a broken harness):
 * - `0` — every case passed (mirrors `review`; unchanged contract).
 * - `1` — the suite **ran** but ≥1 case FAILED (a deterministic check or the judge fell below
 *   threshold). A *product* signal: real, gradeable results, some below the bar.
 * - `2` — **harness error**: the suite couldn't be meaningfully evaluated — the suite file failed
 *   to load/parse, config failed to build, or **every** case's SUT run failed (`sutOk:false`, e.g.
 *   a transport/auth/config failure produced no answer to grade). An *environment* signal.
 *
 * The suite-vs-harness split is anchored on `sutOk` (see `classifyEvalExit`), not the verdict: a
 * case that ran (`sutOk:true`) but whose judge errored, or whose answer failed a check, is still a
 * real result → exit `1`, never `2`. Unlike `batch`, which exits 0 regardless of per-cell quality.
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function evalCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('eval')
    .description(
      'Grade a suite of cases against the SUT agent with deterministic checks and/or an LLM ' +
        'judge ("pytest for prompts"). Exit code: 0 = all cases passed, 1 = a case failed, ' +
        '2 = harness error (bad suite/config, or the SUT could not run).'
    )
    .argument('<suite>', 'Path to the eval suite YAML file')
    .option('-j, --concurrency <n>', 'Max in-flight cases', parseIntOption)
    .option(
      '-o, --output <dir>',
      'Directory to write structured per-case JSON + results.json summary to ' +
        '(default: a timestamped dir alongside other gth reports)'
    )
    .option(
      '--judge <profile>',
      'Identity profile whose model judges the cases (defaults to the SUT model). ' +
        'Overrides the suite-level judge_profile.'
    )
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gsloth eval eval/js-basics.yaml\n' +
        '  $ gsloth eval eval/js-basics.yaml --judge strict-judge\n' +
        '  $ gsloth eval eval/authz-matrix.yaml -j 8 -o eval/out/authz\n'
    )
    .action(async (suitePath: string, options: EvalCommandOptions) => {
      try {
        const config = await initConfig(commandLineConfigOverrides);

        // Specific `.js` subpaths (not the bare package root), matching batchCommand.ts's
        // convention — vitest's workspace-import resolver recognizes these and resolves straight to
        // source, so specs exercise live `packages/batch/src` rather than a `dist/` build.
        const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
        const { runEvalSuite, classifyEvalExit } = await import('@gaunt-sloth/batch/evalRunner.js');
        const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
        const { resolveReporters } = await import('@gaunt-sloth/batch/reporters/registry.js');
        const { driveReporters } = await import('@gaunt-sloth/batch/reporters/drive.js');

        const suiteText = readFileFromProjectDir(suitePath);
        const suite = parseEvalSuite(suiteText, suitePath);

        // BATCH-12 PRECONDITION — trustworthy loads (no false-green): every suite-declared identity
        // must resolve to its OWN config (`.gsloth-settings/<name>/`), not the global/plain
        // fallback. Verify ALL of them with GS2-62's PURE, catchable helper BEFORE building any
        // per-identity config, because handing a bad profile to `initConfig({ …, identityProfile })`
        // would hit its uncatchable `exit(1)` and collapse the harness-vs-product (2-vs-1) exit-code
        // distinction. A silent wrong-identity run is the worst failure for an auth matrix — so an
        // unresolved identity throws here → outer catch → exit 2, and NOTHING runs.
        const suiteIdentities = suite.identities ?? [];
        const unresolvedIdentities = suiteIdentities.filter(
          (identity) => !resolveIdentityProfileConfigPath(identity)
        );
        if (unresolvedIdentities.length > 0) {
          throw new Error(
            `identity profile(s) not found: ${unresolvedIdentities.join(', ')} — each suite ` +
              '`identities` entry must have its own config file in ' +
              '.gsloth/.gsloth-settings/<name>/. No cases were run.'
          );
        }

        // Build the SUT run function(s), selected by `target.type`. The eval runner is
        // target-agnostic — it just consumes an injected single-turn `runCell` and multi-turn
        // `runConversation` — so the target only changes which builders produce them. The judge is
        // orthogonal: it always grades via the local gth `config.llm` (built above), regardless of
        // which target produced the answer, so the whole content-assertion + judge surface works
        // for both targets.
        let runCell: RunCellFn | undefined;
        let runConversation: RunConversationFn | undefined;
        let runCellByIdentity: Map<string, RunCellFn> | undefined;
        let runConversationByIdentity: Map<string, RunConversationFn> | undefined;
        if (suite.target.type === 'adk-agent') {
          // BATCH-14: drive an EXTERNAL Google ADK agent over A2A. The agent runs out-of-process
          // (its own model/tools/auth), so there is no per-identity gth config — the `identities`
          // matrix is rejected for this target at parse time, leaving only the single-run path.
          const { buildAdkRunCell, buildAdkRunConversation } =
            await import('#src/commands/adkEvalRunner.js');
          runCell = buildAdkRunCell(suite.target);
          runConversation = buildAdkRunConversation(suite.target);
        } else if (suite.target.type === 'ag-ui') {
          // BATCH-15: drive an EXTERNAL AG-UI agent over HTTP/SSE. Like the ADK target, the agent
          // runs out-of-process (its own model/tools/auth), so there is no per-identity gth config —
          // the `identities` matrix is rejected for this target at parse time, leaving only the
          // single-run path. Unlike ADK, the AG-UI wire streams tool calls, so the runner captures
          // them and `must_call`/`must_not_call` grade normally.
          const { buildAgUiRunCell, buildAgUiRunConversation } =
            await import('#src/commands/agUiEvalRunner.js');
          runCell = buildAgUiRunCell(suite.target);
          runConversation = buildAgUiRunConversation(suite.target);
        } else {
          // gth-agent (unchanged). With no identities: one runCell under the invoked profile. With
          // identities: one runCell per identity, each from a fresh `initConfig({ …, identityProfile
          // })` (mirrors `gth batch --models`' per-model construction — a genuinely fresh `.llm`,
          // never a structural clone), built ONCE per identity and reused across cases by the runner.
          // An identity profile's manual `mcpServers.<n>.headers.Authorization` (CFG-4) flows through
          // this config path as-is — never stripped, rewritten, or warned on.
          // BATCH-12 Task 2: build BOTH seams — the single-turn `runCell` (proven `runSingleShot`
          // path) and the multi-turn `runConversation` — from the ONE already-resolved config per
          // identity/SUT (no extra `initConfig`; the runner picks per case by `turns.length`). The
          // shared `ProductionRunCellOptions` frames each the same way.
          const runCellOptions = {
            command: 'ask',
            sourcePrefix: 'EVAL',
            wrapBlockPrefix: 'message',
            wrapPrefix: 'user message',
          } as const;
          if (suiteIdentities.length > 0) {
            runCellByIdentity = new Map();
            runConversationByIdentity = new Map();
            for (const identity of suiteIdentities) {
              const identityConfig = await initConfig({
                ...commandLineConfigOverrides,
                identityProfile: identity,
              });
              const identityPreamble = getAskSystemPrompt(identityConfig);
              runCellByIdentity.set(
                identity,
                await buildProductionRunCell(
                  identityConfig,
                  identityPreamble,
                  commandLineConfigOverrides,
                  runCellOptions
                )
              );
              runConversationByIdentity.set(
                identity,
                await buildProductionRunConversation(
                  identityConfig,
                  identityPreamble,
                  runCellOptions
                )
              );
            }
          } else {
            const preamble = getAskSystemPrompt(config);
            runCell = await buildProductionRunCell(
              config,
              preamble,
              commandLineConfigOverrides,
              runCellOptions
            );
            runConversation = await buildProductionRunConversation(
              config,
              preamble,
              runCellOptions
            );
          }
        }

        // BATCH-10 Task 2: resolve the judge identity profile (CLI `--judge` > suite `judge_profile`
        // > none). When set, build a SEPARATE config for it — the same supported
        // `initConfig({ …overrides, identityProfile })` path `gth batch --models` uses to
        // reconstruct a fresh `.llm` (never a structural clone of an already-built model) — so the
        // judge runs under its own model. When unset, the judge shares the SUT's config, unchanged.
        const judgeProfile = resolveJudgeProfile(options.judge, suite.judgeProfile);
        if (judgeProfile && !resolveIdentityProfileConfigPath(judgeProfile)) {
          // GS2-62 (BATCH-10 review Minor 1): pre-check the requested judge profile with the PURE
          // helper and throw our OWN catchable error. Without this, `initConfig({ …, identityProfile
          // })` would silently fall back to the global (or plain) config on a bad profile and the
          // self-describing notice below would print `Judge: profile "<typo>" (model: <global>)` —
          // asserting a profile that never loaded. The throw is caught by the outer try/catch →
          // exit 2 (harness error). We can't lean on initConfig's own hard-error here: that path
          // calls the uncatchable `exit(1)`, which would end the process with code 1 and collapse
          // the harness-vs-product (2-vs-1) exit-code distinction.
          throw new Error(
            `judge profile "${judgeProfile}" not found: no config file in ` +
              `.gsloth/.gsloth-settings/${judgeProfile}/`
          );
        }
        const judgeConfig = judgeProfile
          ? await initConfig({ ...commandLineConfigOverrides, identityProfile: judgeProfile })
          : config;
        const judge = buildProductionJudge(judgeConfig);

        const summary = await runEvalSuite(suite, {
          runCell,
          runCellByIdentity,
          runConversation,
          runConversationByIdentity,
          judge,
          concurrency: options.concurrency,
        });

        const outputDir = options.output ?? defaultEvalOutputDir();
        writeEvalOutput(outputDir, summary);

        // BATCH-19 A1: render the run through the reporter facility instead of a hard-coded summary.
        // `writeEvalOutput` (results.json + per-cell JSON) is always-on core output, independent of
        // any reporter; reporters are an additional rendering layer. A1 ships only the built-in
        // `text` reporter — a byte-for-byte port of the former `printSummary` — driven here in
        // lifecycle order; the `--reporter` flag + custom/JUnit reporters are A2.
        const reporters = resolveReporters(['text']);
        await driveReporters(reporters, summary, {
          suitePath,
          outputDir,
          judgeNotice: judgeProfile
            ? { profile: judgeProfile, model: judgeModelName(judgeConfig) }
            : undefined,
        });

        // BATCH-11: distinct exit codes — 0 pass / 1 suite ran but a case FAILED / 2 no gradeable
        // results (every SUT run failed). `setExitCode` is only called for a non-zero code; `0` is
        // the default process exit code, preserving the "not set on a clean pass" behavior.
        const exitCode = classifyEvalExit(summary);
        if (exitCode !== 0) {
          setExitCode(exitCode);
        }
      } catch (error) {
        // BATCH-11: a harness-level error the run never recovered from — suite-file load/parse
        // error, config error, or any unexpected setup/run failure. The suite couldn't be
        // meaningfully evaluated, so this is an *environment* signal (exit 2), distinct from a
        // product regression (exit 1). Surface the reason; do NOT rethrow — an uncaught throw would
        // surface as a generic exit 1 via the entry point, collapsing the 1-vs-2 distinction.
        displayError(
          `eval harness error: ${error instanceof Error ? error.message : String(error)}`
        );
        setExitCode(2);
      }
    });
}
