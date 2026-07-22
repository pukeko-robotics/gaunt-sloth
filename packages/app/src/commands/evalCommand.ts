import { Command } from 'commander';
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
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
import {
  displayError,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getProjectDir, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  fileSafeLocalDate,
  getGslothFilePath,
  importExternalFile,
  readFileFromProjectDir,
} from '@gaunt-sloth/core/utils/fileUtils.js';
import type {
  EvalCaseResult,
  EvalReporterFactory,
  EvalSuiteSummary,
  JudgeFn,
  RunCellFn,
  RunConversationFn,
} from '@gaunt-sloth/batch';

interface EvalCommandOptions {
  /** `-j/--concurrency <n>` — max in-flight cases. */
  concurrency?: number;
  /** `-o/--output <dir>` — where structured per-case + summary output is written. */
  output?: string;
  /** `--judge <profile>` — identity profile whose model judges the cases (BATCH-10 Task 2).
   * Overrides the suite's `judge_profile`; omit to judge with the SUT model. */
  judge?: string;
  /** `-r/--reporter <names>` — the reporters to render the run through (BATCH-19 A2). Repeatable and
   * comma-splittable; the collector accumulates raw values, {@link normalizeReporterNames} splits +
   * de-duplicates them. Absent = the default `['text']`. */
  reporter?: string[];
}

/** Split each collected `--reporter` value on `,`, flatten, trim, drop blanks, and de-duplicate
 * (order-preserving), so `-r junit,text` and `-r junit -r text` both yield `['junit','text']`. */
export function normalizeReporterNames(collected: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of collected) {
    for (const name of raw.split(',').map((n) => n.trim())) {
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * Build the `custom` reporter-factory map handed to `resolveReporters`. It always registers the
 * BUNDLED reporters — JUnit (results.xml artifact) and TeamCity (live service messages) — through
 * the SAME public `custom` seam a user reporter uses (the point: it proves the plug-in contract
 * from an out-of-core package), then overlays any config-declared reporters. A config reporter may
 * reuse a built-in/bundled name — config wins on a collision, so it is added last.
 *
 * A config reporter's module path is resolved relative to the PROJECT dir (the same base
 * `readFileFromProjectDir` uses) and imported via {@link importExternalFile} (which turns it into a
 * `file://` URL and supports `.ts` through jiti). Its DEFAULT export must be an `EvalReporterFactory`
 * (`() => EvalReporter`); a missing file, a failed import, or a non-function default export THROWS —
 * caught by the command's outer try/catch → exit 2 (harness error). It is the user's own trusted
 * config (already arbitrary JS), so nothing is sandboxed.
 */
async function buildCustomReporterFactories(
  config: GthConfig
): Promise<Record<string, EvalReporterFactory>> {
  const custom: Record<string, EvalReporterFactory> = {};

  const { createJUnitReporter, JUNIT_REPORTER_NAME } =
    await import('@gaunt-sloth/eval-reporter-junit/index.js');
  custom[JUNIT_REPORTER_NAME] = createJUnitReporter;

  const { createTeamCityReporter, TEAMCITY_REPORTER_NAME } =
    await import('@gaunt-sloth/eval-reporter-teamcity/index.js');
  custom[TEAMCITY_REPORTER_NAME] = createTeamCityReporter;

  for (const [name, modulePath] of Object.entries(config.reporters ?? {})) {
    const absPath = resolve(getProjectDir(), modulePath);
    let mod: Record<string, unknown>;
    try {
      mod = await importExternalFile(absPath);
    } catch (error) {
      throw new Error(
        `failed to load config reporter "${name}" from "${modulePath}" (${absPath}): ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
    const factory = mod.default;
    if (typeof factory !== 'function') {
      throw new Error(
        `config reporter "${name}" (${modulePath}) must export a default function ` +
          `(an EvalReporterFactory: () => EvalReporter); got ${typeof factory}.`
      );
    }
    custom[name] = factory as EvalReporterFactory;
  }

  return custom;
}

/** Default output dir when `-o/--output` is omitted: a timestamped dir next to other gth reports —
 * same convention as `defaultBatchOutputDir` in `batchCommand.ts`, `_EVAL` suffix instead. */
export function defaultEvalOutputDir(): string {
  return getGslothFilePath(`gth_${fileSafeLocalDate()}_EVAL`);
}

/** One resolved suite to run: `readPath` is what {@link readFileFromProjectDir} reads (the CLI
 * string as given for a file arg — so the single-suite mock/read path is byte-for-byte unchanged —
 * or the absolute child path for a directory-expanded suite); `absPath` is the resolved absolute
 * path used ONLY for de-duplication. */
interface ResolvedEvalSuite {
  readPath: string;
  absPath: string;
}

/** `basename(path)` with its extension removed — the per-suite output subdir name and the JUnit
 * `<testsuites>` name. `eval/authz-matrix.yaml` → `authz-matrix`. */
function suiteStem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * Deterministically resolve the CLI `<suites...>` args into the ordered list of suites to run
 * (BATCH-19 Task B, Deliverable 1):
 * - A **file** (or a path that doesn't exist on disk — its read is deferred so a missing suite
 *   surfaces as that suite's own harness error, keeping the single-suite behavior byte-for-byte) →
 *   that one suite, read by the exact CLI string given.
 * - A **directory** → its **direct-child** `*.yaml`/`*.yml` files only (NON-recursive), sorted
 *   lexicographically. An empty / no-match directory yields no suites and one harness `error` (the
 *   caller folds it into the aggregate exit → 2) instead of throwing, so any GOOD sibling inputs
 *   still run.
 *
 * The given arg order is preserved and each directory is expanded in place; suites are
 * de-duplicated by **resolved absolute path** (the same file named twice, directly or via a
 * directory, runs once).
 */
function resolveEvalSuiteInputs(inputs: string[]): {
  suites: ResolvedEvalSuite[];
  errors: string[];
} {
  const projectDir = getProjectDir();
  const suites: ResolvedEvalSuite[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const push = (readPath: string, absPath: string): void => {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    suites.push({ readPath, absPath });
  };

  for (const input of inputs) {
    const abs = resolve(projectDir, input);
    let isDirectory = false;
    try {
      isDirectory = statSync(abs).isDirectory();
    } catch {
      // Non-existent path: treat as a file suite and let its read fail as that suite's own harness
      // error (single-suite behavior preserved; a real file mock/read is keyed on the CLI string).
      isDirectory = false;
    }

    if (!isDirectory) {
      push(input, abs);
      continue;
    }

    const yamlChildren = readdirSync(abs)
      .filter((name) => {
        const ext = extname(name).toLowerCase();
        return ext === '.yaml' || ext === '.yml';
      })
      .sort();
    if (yamlChildren.length === 0) {
      errors.push(`eval suite directory "${input}" contains no .yaml/.yml files`);
      continue;
    }
    for (const name of yamlChildren) {
      const childAbs = resolve(abs, name);
      push(childAbs, childAbs);
    }
  }

  return { suites, errors };
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
    .argument(
      '<suites...>',
      'Eval suite YAML file(s) or directory(ies). A directory runs its direct-child *.yaml/*.yml ' +
        'suites (non-recursive, sorted). Multiple suites report ONE aggregate exit code; each ' +
        'writes into its own <output>/<suite-name>/ subdir (a single suite writes into <output> directly).'
    )
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
    .option(
      '-r, --reporter <names>',
      'Reporter(s) to render the run through (repeatable; comma-separated). Built-in: "text" ' +
        '(default), "junit" (writes results.xml), "teamcity" (live ##teamcity[...] service ' +
        'messages). REPLACES the default, so "--reporter junit" is JUnit only. The always-on ' +
        'results.json + per-cell JSON are written regardless.',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .addHelpText(
      'after',
      '\n' +
        'Reporters:\n' +
        '  text (default)  a human-readable PASS/FAIL summary on the console\n' +
        '  junit           an Ant-JUnit results.xml (for TeamCity / CI JUnit readers)\n' +
        '  teamcity        live ##teamcity[...] service messages on stdout (a TeamCity build\n' +
        '                  shows per-case pass/fail live; no artifact wiring needed)\n' +
        '  Custom reporters are declared in config under `reporters: { <name>: <module path> }`.\n' +
        '  --reporter REPLACES the default set (it does not add to it); pass every reporter you\n' +
        '  want, e.g. `--reporter text,junit`. results.json is always written, regardless.\n' +
        '\n' +
        'Examples:\n' +
        '  $ gsloth eval eval/js-basics.yaml\n' +
        '  $ gsloth eval eval/js-basics.yaml --judge strict-judge\n' +
        '  $ gsloth eval eval/authz-matrix.yaml -j 8 -o eval/out/authz\n' +
        '  $ gsloth eval eval/js-basics.yaml eval/authz-matrix.yaml   # many suites, one exit\n' +
        '  $ gsloth eval eval/ -o eval/out --reporter junit           # a whole directory\n' +
        '  $ gsloth eval eval/js-basics.yaml --reporter junit\n' +
        '  $ gsloth eval eval/js-basics.yaml --reporter text,junit\n'
    )
    .action(async (suitePaths: string[], options: EvalCommandOptions) => {
      try {
        // Specific `.js` subpaths (not the bare package root), matching batchCommand.ts's
        // convention — vitest's workspace-import resolver recognizes these and resolves straight to
        // source, so specs exercise live `packages/batch/src` rather than a `dist/` build.
        const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
        const { runEvalSuite, classifyEvalExit } = await import('@gaunt-sloth/batch/evalRunner.js');
        const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
        const { resolveReporters } = await import('@gaunt-sloth/batch/reporters/registry.js');
        const { driveReporters } = await import('@gaunt-sloth/batch/reporters/drive.js');

        // The reporter selection (`--reporter`, else the default `['text']`) and the output ROOT are
        // invocation-level — the same for every suite. REPLACES the default: the `--reporter` value
        // when given, else `['text']`.
        const reporterNames = options.reporter
          ? normalizeReporterNames(options.reporter)
          : ['text'];
        const outputRoot = options.output ?? defaultEvalOutputDir();

        // BATCH-19 Task B: run ONE whole suite — parse, precondition-check its identities, build its
        // configs/reporters, run, write its structured output, and drive its reporters — RETURNING
        // its summary. THROWS on this suite's own harness error (parse/config/reporter/precondition
        // failure), which the caller catches per suite so one bad suite never aborts the good ones.
        //
        // Task B, Deliverable 2 — the `-i` papercut: a MATRIX suite (declares `identities:`) must run
        // with NO base `-i`. The per-identity configs come from the suite's `identities:` list (each
        // pre-validated by the precondition below), so the base config used for reporters + the
        // default judge is the FIRST identity's already-built config — the matrix path NEVER calls
        // `initConfig` without an `identityProfile`. That is the fix: the old top-level
        // `initConfig(overrides)` demanded a resolvable base config (a matrix-only project has none),
        // and its terminal `exit(1)` is uncatchable, so it can't be reached at all on this path. The
        // NON-matrix path is unchanged — the base config is still `initConfig(overrides)`. (Configs
        // are built per suite, not cached across suites — a documented non-goal.)
        const runOneSuite = async (
          suite: ResolvedEvalSuite,
          suiteOutputDir: string
        ): Promise<EvalSuiteSummary> => {
          const suiteText = readFileFromProjectDir(suite.readPath);
          const parsedSuite = parseEvalSuite(suiteText, suite.readPath);

          // BATCH-12 PRECONDITION — trustworthy loads (no false-green): every suite-declared identity
          // must resolve to its OWN config (`.gsloth-settings/<name>/`), not the global/plain
          // fallback. Verify ALL of them with GS2-62's PURE, catchable helper BEFORE building any
          // per-identity config, because handing a bad profile to `initConfig({ …, identityProfile })`
          // would hit its uncatchable `exit(1)` and collapse the harness-vs-product (2-vs-1) exit-code
          // distinction. A silent wrong-identity run is the worst failure for an auth matrix — so an
          // unresolved identity throws here → per-suite catch → exit 2, and NOTHING runs.
          const suiteIdentities = parsedSuite.identities ?? [];
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

          const runCellOptions = {
            command: 'ask',
            sourcePrefix: 'EVAL',
            wrapBlockPrefix: 'message',
            wrapPrefix: 'user message',
          } as const;

          // Build the SUT run function(s), selected by `target.type`, AND resolve the base config
          // used for the reporters + the default (SUT-model) judge. The eval runner is
          // target-agnostic — it just consumes an injected single-turn `runCell` and multi-turn
          // `runConversation` — so the target only changes which builders produce them.
          let runCell: RunCellFn | undefined;
          let runConversation: RunConversationFn | undefined;
          let runCellByIdentity: Map<string, RunCellFn> | undefined;
          let runConversationByIdentity: Map<string, RunConversationFn> | undefined;
          let baseConfig: GthConfig;
          if (suiteIdentities.length > 0 && parsedSuite.target.type === 'gth-agent') {
            // MATRIX (gth-agent): one runCell per identity, each from a fresh
            // `initConfig({ …, identityProfile })` (mirrors `gth batch --models`' per-model
            // construction — a genuinely fresh `.llm`, never a structural clone), built ONCE per
            // identity and reused across cases by the runner. An identity profile's manual
            // `mcpServers.<n>.headers.Authorization` (CFG-4) flows through as-is. The base config for
            // reporters + the default judge is the FIRST identity's config (reused, not rebuilt) — so
            // this path makes NO `initConfig` call without an `identityProfile` (Deliverable 2).
            runCellByIdentity = new Map();
            runConversationByIdentity = new Map();
            let firstIdentityConfig: GthConfig | undefined;
            for (const identity of suiteIdentities) {
              const identityConfig = await initConfig({
                ...commandLineConfigOverrides,
                identityProfile: identity,
              });
              if (!firstIdentityConfig) firstIdentityConfig = identityConfig;
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
            // `firstIdentityConfig` is always set here (suiteIdentities is non-empty).
            baseConfig = firstIdentityConfig!;
          } else if (parsedSuite.target.type === 'adk-agent') {
            // BATCH-14: drive an EXTERNAL Google ADK agent over A2A. The agent runs out-of-process
            // (its own model/tools/auth), so there is no per-identity gth config — the `identities`
            // matrix is rejected for this target at parse time, leaving only the single-run path. The
            // judge still grades via the local gth config, so build it from `initConfig(overrides)`.
            baseConfig = await initConfig(commandLineConfigOverrides);
            const { buildAdkRunCell, buildAdkRunConversation } =
              await import('#src/commands/adkEvalRunner.js');
            runCell = buildAdkRunCell(parsedSuite.target);
            runConversation = buildAdkRunConversation(parsedSuite.target);
          } else if (parsedSuite.target.type === 'ag-ui') {
            // BATCH-15: drive an EXTERNAL AG-UI agent over HTTP/SSE. Like the ADK target, the agent
            // runs out-of-process (its own model/tools/auth), so there is no per-identity gth config —
            // the `identities` matrix is rejected for this target at parse time. Unlike ADK, the AG-UI
            // wire streams tool calls, so the runner captures them and `must_call`/`must_not_call`
            // grade normally. The judge still grades via the local gth `initConfig(overrides)` config.
            baseConfig = await initConfig(commandLineConfigOverrides);
            const { buildAgUiRunCell, buildAgUiRunConversation } =
              await import('#src/commands/agUiEvalRunner.js');
            runCell = buildAgUiRunCell(parsedSuite.target);
            runConversation = buildAgUiRunConversation(parsedSuite.target);
          } else {
            // gth-agent, NO identities (unchanged): one runCell/runConversation under the invoked
            // profile, from the single `initConfig(overrides)` base config (byte-for-byte as before).
            baseConfig = await initConfig(commandLineConfigOverrides);
            const preamble = getAskSystemPrompt(baseConfig);
            runCell = await buildProductionRunCell(
              baseConfig,
              preamble,
              commandLineConfigOverrides,
              runCellOptions
            );
            runConversation = await buildProductionRunConversation(
              baseConfig,
              preamble,
              runCellOptions
            );
          }

          // BATCH-19 A2: resolve the reporter selection — BEFORE the suite runs and before any output
          // is written — so an unknown `--reporter` name (or a broken config-reporter module) fails
          // fast → this suite's harness error (exit 2) with NOTHING run and no misleading partial
          // output. The bundled JUnit reporter and any config-declared reporters are registered
          // through the ONE public `custom` seam `resolveReporters` exposes (config wins on a name
          // collision). Reporters are re-resolved per suite so each suite gets fresh reporter state
          // (e.g. its own JUnit document). An unknown name throws (message lists the available
          // reporters) → per-suite catch → exit 2.
          const customReporterFactories = await buildCustomReporterFactories(baseConfig);
          const reporters = resolveReporters(reporterNames, customReporterFactories);

          // BATCH-10 Task 2: resolve the judge identity profile (CLI `--judge` > suite `judge_profile`
          // > none). When set, build a SEPARATE config for it — the same supported
          // `initConfig({ …overrides, identityProfile })` path `gth batch --models` uses to
          // reconstruct a fresh `.llm` — so the judge runs under its own model. When unset, the judge
          // shares the base config (the SUT's for a single run; the FIRST identity's for a matrix).
          const judgeProfile = resolveJudgeProfile(options.judge, parsedSuite.judgeProfile);
          if (judgeProfile && !resolveIdentityProfileConfigPath(judgeProfile)) {
            // GS2-62 (BATCH-10 review Minor 1): pre-check the requested judge profile with the PURE
            // helper and throw our OWN catchable error. Without this, `initConfig({ …, identityProfile
            // })` would silently fall back to the global (or plain) config on a bad profile and the
            // self-describing notice below would print `Judge: profile "<typo>" (model: <global>)` —
            // asserting a profile that never loaded. The throw is caught per suite → exit 2 (harness
            // error). We can't lean on initConfig's own hard-error here: that path calls the
            // uncatchable `exit(1)`, which would end the process with code 1 and collapse the
            // harness-vs-product (2-vs-1) exit-code distinction.
            throw new Error(
              `judge profile "${judgeProfile}" not found: no config file in ` +
                `.gsloth/.gsloth-settings/${judgeProfile}/`
            );
          }
          const judgeConfig = judgeProfile
            ? await initConfig({ ...commandLineConfigOverrides, identityProfile: judgeProfile })
            : baseConfig;
          const judge = buildProductionJudge(judgeConfig);

          const summary = await runEvalSuite(parsedSuite, {
            runCell,
            runCellByIdentity,
            runConversation,
            runConversationByIdentity,
            judge,
            concurrency: options.concurrency,
          });

          writeEvalOutput(suiteOutputDir, summary);

          // BATCH-19: render the run through the reporters resolved above (A1 seam + A2 selection).
          // `writeEvalOutput` (results.json + per-cell JSON) is always-on core output, independent of
          // any reporter — a JUnit run writes results.xml IN ADDITION, never instead. Reporters are an
          // additional rendering layer, driven here in lifecycle order, with THIS suite's dir + path.
          await driveReporters(reporters, summary, {
            suitePath: suite.readPath,
            outputDir: suiteOutputDir,
            judgeNotice: judgeProfile
              ? { profile: judgeProfile, model: judgeModelName(judgeConfig) }
              : undefined,
          });

          return summary;
        };

        // Deliverable 1: resolve the CLI args into the ordered, de-duplicated suite list (files as
        // given; directories → their sorted direct-child *.yaml/*.yml). A no-match directory records
        // a harness error but does not abort the good inputs.
        const { suites, errors: resolutionErrors } = resolveEvalSuiteInputs(suitePaths);
        let anyHarnessError = false;
        for (const message of resolutionErrors) {
          displayError(`eval harness error: ${message}`);
          anyHarnessError = true;
        }

        // Exactly one resolved suite → write DIRECTLY into the output dir (byte-for-byte with the
        // single-suite contract). Multiple → each suite writes into `<output>/<suiteStem>/`, so a CI
        // glob collects them and suites never clobber. On a stem collision across resolved suites,
        // disambiguate deterministically (`-2`, `-3`, … in resolved order) and WARN — never silently
        // overwrite.
        const single = suites.length === 1;
        const usedStems = new Map<string, number>();
        const combinedCases: EvalCaseResult[] = [];
        for (const suite of suites) {
          let suiteOutputDir = outputRoot;
          if (!single) {
            const stem = suiteStem(suite.readPath);
            const priorCount = usedStems.get(stem) ?? 0;
            usedStems.set(stem, priorCount + 1);
            const dirName = priorCount === 0 ? stem : `${stem}-${priorCount + 1}`;
            if (priorCount > 0) {
              displayWarning(
                `eval: two suites share the output name "${stem}"; writing "${suite.readPath}" ` +
                  `output to "${dirName}/" so it does not clobber the earlier one.`
              );
            }
            suiteOutputDir = join(outputRoot, dirName);
          }

          try {
            const summary = await runOneSuite(suite, suiteOutputDir);
            combinedCases.push(...summary.cases);
          } catch (error) {
            // A harness-level error for THIS suite (parse/config/reporter/precondition/unexpected).
            // A harness error in ANY suite dominates the aggregate exit → 2 (a partial run can't be
            // trusted), but the good suites still ran and wrote their output.
            displayError(
              `eval harness error${single ? '' : ` in ${suite.readPath}`}: ` +
                (error instanceof Error ? error.message : String(error))
            );
            anyHarnessError = true;
          }
        }

        // Aggregate three-way exit: concatenate every successful suite's cases into ONE combined
        // summary and call `classifyEvalExit` ONCE. A harness error in ANY suite dominates → exit 2.
        // For N=1 this reproduces the single-suite exit EXACTLY (one summary, or one harness error →
        // 2); `classifyEvalExit`'s own empty/all-`!sutOk` rule also yields 2 when nothing gradeable
        // ran anywhere.
        const passed = combinedCases.filter((result) => result.verdict === 'PASS').length;
        const combined: EvalSuiteSummary = {
          total: combinedCases.length,
          passed,
          failed: combinedCases.length - passed,
          cases: combinedCases,
        };

        // Multi-suite only: one aggregate total line AFTER every suite's own per-suite output. For
        // N=1 print NOTHING extra — the single suite's text reporter already printed its verdict, so
        // the output stays byte-for-byte identical to the single-suite contract.
        if (suites.length > 1) {
          const totalLine =
            `EVAL TOTAL: ${combined.passed}/${combined.total} across ${suites.length} suites, ` +
            `${combined.failed} failed`;
          if (combined.failed === 0 && !anyHarnessError) {
            displaySuccess(totalLine);
          } else {
            displayWarning(totalLine);
          }
        }

        const exitCode = anyHarnessError ? 2 : classifyEvalExit(combined);
        if (exitCode !== 0) {
          setExitCode(exitCode);
        }
      } catch (error) {
        // BATCH-11: an invocation-level harness error the run never recovered from (e.g. a failed
        // dynamic import) — distinct from a per-suite error (caught in the loop). The suites couldn't
        // be meaningfully evaluated, so this is an *environment* signal (exit 2). Surface the reason;
        // do NOT rethrow — an uncaught throw would surface as a generic exit 1 via the entry point,
        // collapsing the 1-vs-2 distinction.
        displayError(
          `eval harness error: ${error instanceof Error ? error.message : String(error)}`
        );
        setExitCode(2);
      }
    });
}
