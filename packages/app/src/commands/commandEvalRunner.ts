/**
 * BATCH-57 — the `command` target's production runner for `gth eval`: start a command-line agent
 * once per case, decode what it printed, and hand the eval runner the same outcome shape the
 * `gth-agent` target produces. The analogue of `agUiEvalRunner.ts` (HTTP/SSE) and
 * `adkEvalRunner.ts` (A2A) for an agent that is a program.
 *
 * ## The prompt never passes through a shell
 *
 * The suite parser has already split `run` into argv (`commandArgv.ts`). The process is started
 * with `shell: false`, and the prompt is either appended as ONE more argv element (`prompt: arg`,
 * the default) or written to the child's stdin (`prompt: stdin`). No program between gth and the
 * agent parses the prompt, so `$(…)`, backticks and quotes in it reach the agent byte for byte and
 * execute nothing. A spec proves this with a prompt built to do damage if it were ever spliced.
 *
 * The cost is on Windows: Node refuses to start a `.cmd`/`.bat` file without a shell, and an
 * npm-installed CLI is a `.cmd` shim there. A suite on Windows names the real executable instead
 * (`node path/to/cli.js …`). That limit is accepted rather than worked around, because the
 * work-around is `cmd.exe /c`, which re-parses its whole command line, the prompt included.
 *
 * ## Timeout
 *
 * Each case has its own budget (`EvalCase.timeoutMs`, resolved at parse). On expiry the whole
 * process TREE is killed — an agent CLI starts its tools as children, and killing only the CLI
 * would leave them running and holding the output pipes open — through the same
 * `killProcessGroup` the shell tool uses (negative pid on POSIX, `taskkill /T` on Windows), with
 * the same SIGTERM-then-SIGKILL escalation. The case then settles WITHOUT waiting for `'close'`:
 * on Windows a surviving grandchild can keep the pipes open and `'close'` never fires, which is the
 * EXT-15 hang. A timed-out case is a harness error (`ok: false`), never a FAIL.
 *
 * ## Harness errors
 *
 * A run that times out, cannot be started, exits non-zero, or prints a transcript the decoder
 * rejects (cut off, or an error result such as Claude Code's `error_max_turns`) is `ok: false`: the
 * case is reported as `SUT run failed` with the reason, and a suite in which every case failed that
 * way exits 2. Grading a run that did not finish would turn the harness's limit into an assertion
 * failure that reads as the agent's choice.
 *
 * BATCH-62 — the one opt-out is `grade_when`: a run whose decoder reports an early ending the case
 * lists (a `--max-turns` cap, say) is graded on the transcript it produced, whatever the exit code,
 * and carries that `outcome` into its result. A decoder throw, a timeout and a signal kill are never
 * graded. See `gradedEnding`.
 *
 * ## Workspaces (BATCH-58)
 *
 * {@link CommandSpawnRequest} carries `cwd` and `env` per call. A case with no `workspace` runs in
 * the directory gth was started in, with gth's own environment object, exactly as before. A case
 * with one gets, per run: a fresh directory (`commandWorkspace.ts`), its `setup` steps started in
 * order through the same spawn seam as the command (no shell, the case's timeout per step, the
 * same tree kill and exit hook), then the command, then the case's BATCH-59 workspace assertions
 * (`file_contains`, `must_not_exist`, then the `after` steps; see `gradeWorkspace` below), then the
 * test seam {@link CommandRunnerOptions.inspectWorkspace}, and the directory is removed last. The
 * assertions are built in rather than passed through that option, so no caller can build a runner
 * that silently skips them. A step that
 * cannot start, exits non-zero or times out is a harness error naming the step, and the command
 * does not run: grading an agent in a half-built fixture would charge the fixture's failure to the
 * agent.
 *
 * @module
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CellRunOutcome,
  CommandTarget,
  CommandWorkspace,
  EvalSuite,
  MatrixCell,
  RunCellFn,
  ToolCallRecord,
  ToolResultRecord,
  WorkspaceAfterStep,
  WorkspaceChecks,
} from '@gaunt-sloth/batch';
import type { DecodedTranscript, TranscriptDecoder } from '@gaunt-sloth/batch';
import {
  isTranscriptDecoderModulePath,
  resolveTranscriptDecoder,
} from '@gaunt-sloth/batch/transcripts/registry.js';
import { COMMAND_TARGET_DEFAULT_TIMEOUT_MS } from '@gaunt-sloth/batch/evalTypes.js';
import { killProcessGroup } from '@gaunt-sloth/agent/tools/GthDevToolkit.js';
import { capToolResultText, TOOL_RESULT_CONTENT_CAP } from '@gaunt-sloth/core/core/runStats.js';
import { importExternalFile } from '@gaunt-sloth/core/utils/fileUtils.js';
import { env, getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { evalToolCallRecords } from '#src/commands/evalToolCallRecords.js';
import {
  buildWorkspaceEnv,
  createWorkspaceDir,
  expandSetupArgv,
  removeWorkspaceDir,
  resolveSuiteDir,
  resolveWorkspaceCwd,
} from '#src/commands/commandWorkspace.js';
import {
  checkFileContains,
  checkMustNotExist,
  WorkspaceUnreadableError,
} from '#src/commands/commandWorkspaceChecks.js';

/** How long a SIGTERM'd tree gets before SIGKILL, matching the shell tool's ladder. */
const KILL_GRACE_MS = 3_000;
/** How long after SIGKILL the case waits for `'close'` before settling without it. */
const SETTLE_AFTER_KILL_MS = 1_000;
/** How much of stderr a harness-error reason quotes. */
const STDERR_TAIL_CHARS = 600;

/** One start of the command. */
export interface CommandSpawnRequest {
  /** The argv to spawn, from the parsed target. */
  argv: string[];
  prompt: string;
  /**
   * How {@link prompt} reaches the child. `none` (a workspace `setup` step) passes no prompt and
   * closes stdin: appending the case's prompt to `git init` would make it a directory name.
   */
  promptDelivery: CommandTarget['prompt'] | 'none';
  timeoutMs: number;
  /** The working directory for the child. */
  cwd: string;
  /** The child's environment. */
  env: NodeJS.ProcessEnv;
}

/** What one start produced. */
export interface CommandRunResult {
  stdout: string;
  stderr: string;
  /** The exit code, or `null` when the child was killed by a signal or never reported one. */
  exitCode: number | null;
  /** `true` when the timeout fired and the tree was killed. */
  timedOut: boolean;
}

/** The spawn seam — {@link runCommandProcess} in production, a fake in tests. */
export type CommandSpawnFn = (request: CommandSpawnRequest) => Promise<CommandRunResult>;

/**
 * The commands this process has started and not yet settled.
 *
 * ## Why gth's exit kills them
 *
 * On POSIX each command leads its own process group (that is what lets the timeout kill the whole
 * tree), so the terminal's Ctrl+C, which signals only the FOREGROUND group, never reaches it. Core's
 * SIGINT and SIGTERM handlers (`systemUtils.ts`) end in `process.exit(0)`, and the per-case timeout
 * timers die with gth. Without this hook an interrupted `gth eval` would leave the agent CLI running
 * with no deadline at all, still editing the directory and still spending tokens.
 *
 * So the first spawn installs ONE `'exit'` listener, and nothing else. `'exit'` runs on every way
 * the process ends that can run code — core's signal handlers calling `process.exit`, an explicit
 * exit, an uncaught exception, a normal end — so this catches Ctrl+C without adding a second
 * SIGINT handler or changing what core's does, and a command that never starts a `command` target
 * never gets the listener. An `'exit'` listener must be synchronous, and `killProcessGroup` is
 * (`process.kill` on POSIX, `spawnSync('taskkill')` on Windows). It sends SIGKILL, because nothing
 * survives gth to escalate a SIGTERM that the agent chose to ignore.
 *
 * A child leaves the set when its run settles, not when it exits: a timed-out run whose grandchild
 * outlived the kill is still worth a last attempt.
 *
 * Limits: a SIGKILL of gth itself runs no code, so it cannot reach the children. On Windows, a child
 * spawned without `detached` shares gth's console, so a console Ctrl+C reaches it directly; an
 * external `TerminateProcess` of gth runs no code there either.
 *
 * BATCH-58 — the same listener removes every live case workspace, AFTER the kills: on Windows a
 * directory is busy while a process still has it as its cwd. `removeWorkspaceDir` is synchronous
 * and retries a busy directory, which is what an `'exit'` listener can afford. A removal that still
 * fails is left behind silently, because there is no run left to report it to. A workspace kept
 * with `--keep-workspaces` is never registered here, so an interrupt keeps it too.
 */
const liveChildren = new Set<ChildProcess>();
const liveWorkspaces = new Set<string>();
let exitHookInstalled = false;

/**
 * Kill every live command's process tree, then remove every live case workspace. The `'exit'`
 * listener; exported for its spec.
 */
export function killLiveCommandChildren(): void {
  for (const child of liveChildren) killProcessGroup(child, 'SIGKILL');
  liveChildren.clear();
  for (const dir of liveWorkspaces) {
    try {
      removeWorkspaceDir(dir);
    } catch {
      // Nothing is left to report to; see the docblock above.
    }
  }
  liveWorkspaces.clear();
}

function installExitHook(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killLiveCommandChildren);
  }
}

function trackLiveChild(child: ChildProcess): void {
  liveChildren.add(child);
  installExitHook();
}

/**
 * Start the command once and collect its output. Rejects only when the process cannot be started
 * (an unknown command, for one); every other outcome resolves, timed out or not.
 */
export function runCommandProcess(request: CommandSpawnRequest): Promise<CommandRunResult> {
  const [command, ...baseArgs] = request.argv;
  const viaArg = request.promptDelivery === 'arg';
  const viaStdin = request.promptDelivery === 'stdin';
  const args = viaArg ? [...baseArgs, request.prompt] : baseArgs;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: request.cwd,
      env: request.env,
      // Unless the prompt goes on stdin, stdin is closed: a `-p` CLI that finds an open pipe may
      // wait on it forever.
      stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // POSIX: lead a process group so the timeout can signal the whole tree. Windows has no
      // groups; `killProcessGroup` uses `taskkill /T` there instead.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    trackLiveChild(child);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      for (const timer of timers) clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        timedOut,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      for (const timer of timers) clearTimeout(timer);
      rejectPromise(new Error(`could not start "${command}": ${error.message}`));
    });
    child.on('close', (code) => finish(code));

    if (viaStdin && child.stdin) {
      // A child that exits without reading its stdin makes the write fail with EPIPE; that is the
      // child's business, and its exit status says what happened.
      child.stdin.on('error', () => undefined);
      child.stdin.end(request.prompt, 'utf8');
    }

    timers.push(
      setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, 'SIGTERM');
        timers.push(
          setTimeout(() => {
            killProcessGroup(child, 'SIGKILL');
            // Settle even if 'close' never comes: a grandchild that outlived the kill can hold the
            // pipes open, and waiting on them is the hang the timeout exists to prevent.
            timers.push(
              setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                finish(null);
              }, SETTLE_AFTER_KILL_MS)
            );
          }, KILL_GRACE_MS)
        );
      }, request.timeoutMs)
    );
  });
}

/**
 * Resolve a target's `transcript` to a decoder: a built-in by name, or the default export of a
 * module, resolved against the directory of the suite file that names it (the decoder belongs to
 * the suite, so a relative path reads the way the suite author sees it).
 */
export async function loadTranscriptDecoder(
  spec: string,
  suiteReadPath: string
): Promise<TranscriptDecoder> {
  if (!isTranscriptDecoderModulePath(spec)) return resolveTranscriptDecoder(spec);
  const modulePath = spec.startsWith('file:')
    ? fileURLToPath(spec)
    : resolve(resolveSuiteDir(suiteReadPath), spec);
  let mod: Record<string, unknown>;
  try {
    mod = await importExternalFile(modulePath);
  } catch (error) {
    throw new Error(
      `failed to load transcript decoder "${spec}": ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  if (typeof mod.default !== 'function') {
    throw new Error(
      `transcript decoder "${spec}" must export a default function (stdout) => transcript; got ` +
        `${typeof mod.default}.`
    );
  }
  return mod.default as TranscriptDecoder;
}

/** Options for {@link buildCommandRunCell}. */
export interface CommandRunnerOptions {
  /** Keep each call's `args` on `toolCalls` (the run-level `evalToolCallArgs`). */
  recordToolCallArgs?: boolean;
  /** The capture cap for result payloads and arguments (`toolResultCaptureMaxBytes`). */
  captureMaxBytes?: number;
  /** The spawn seam; {@link runCommandProcess} unless a test injects one. */
  spawnCommand?: CommandSpawnFn;
  /** The child's working directory; the directory gth was started in unless set. */
  cwd?: string;
  /**
   * The child's environment; gth's own unless set. For a case with a workspace this is also the
   * INHERITED environment that the workspace's `env` is merged over and `{{env.NAME}}` reads.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * BATCH-58 `--keep-workspaces`: leave each case's workspace on disk (and out of the exit hook's
   * clean-up) and report its path through {@link onWorkspaceKept}.
   */
  keepWorkspaces?: boolean;
  /** Called with each kept workspace's case id and path, as soon as the directory exists. */
  onWorkspaceKept?: (caseId: string, dir: string) => void;
  /** Called when a workspace could not be removed; the case's result stands. */
  onWorkspaceRemoveFailed?: (caseId: string, dir: string, reason: string) => void;
  /**
   * A look at the workspace after the case's command finished, its outcome was decoded and the
   * case's own workspace assertions were graded, while the workspace still exists and before it is
   * removed. It returns the outcome to report, so an inspection can turn a run into a harness error
   * or add to it. Not called for a case without a workspace, or when setup failed. Production
   * passes none: the suite's assertions are graded by the runner itself.
   */
  inspectWorkspace?: (
    workspace: { caseId: string; dir: string },
    outcome: CellRunOutcome
  ) => CellRunOutcome | Promise<CellRunOutcome>;
  /**
   * BATCH-66 `--keep-transcripts`: called with what the case's command printed, as soon as it
   * finishes and before the run is judged, so a run that timed out, exited non-zero or printed a
   * transcript the decoder rejects is reported too. That harness-error run is the one whose output
   * is most needed. It is not called when the command could not be started (there is no output),
   * nor for a workspace `setup` or `after` step: their output is not the agent's.
   */
  onTranscript?: (cell: MatrixCell, run: CommandRunResult) => void;
}

/**
 * BATCH-66 — the file name, without extension, of one run's kept transcript: `<id>` for a case that
 * runs once, `<id>#run<n>` for each run of a repeated case.
 *
 * The run suffix is BATCH-60's own name for a run cell, and it is used rather than a `-run-<n>`
 * suffix because `#` is outside the case-id alphabet (`/^[\w.-]+$/`, checked at parse): case `a`
 * run 1 and a separate case `a-run-1` could otherwise share a file and overwrite each other. That
 * same parse-time check is what keeps an id from naming a path outside the output directory, so the
 * id needs no further sanitising here. A `command` target rejects `identities` and `sweep` at parse,
 * so a run has no identity or sweep cell to add to the name.
 */
export function transcriptFileBase(cell: Pick<MatrixCell, 'id' | 'run'>): string {
  return cell.run !== undefined ? `${cell.id}#run${cell.run}` : cell.id;
}

/**
 * BATCH-66 — write one run's raw output into `outputDir`, beside the case's `<id>.json`:
 * `<base>.stdout.txt` always, and `<base>.stderr.txt` only when the command printed to standard
 * error. Both are written exactly as captured, with no header, so a kept stdout can be fed straight
 * back to a decoder. {@link runCommandProcess} keeps all of both streams, so nothing in either file
 * was cut; the 600-character stderr tail is only what a harness-error reason quotes.
 */
export function writeCommandTranscript(
  outputDir: string,
  cell: Pick<MatrixCell, 'id' | 'run'>,
  run: Pick<CommandRunResult, 'stdout' | 'stderr'>
): void {
  const base = transcriptFileBase(cell);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${base}.stdout.txt`), run.stdout);
  const stderrFile = join(outputDir, `${base}.stderr.txt`);
  // A run with nothing on stderr removes the file a previous run into the same `-o` left under
  // this name. Left in place it would sit beside this run's stdout and read as this run's.
  if (run.stderr.length > 0) writeFileSync(stderrFile, run.stderr);
  else rmSync(stderrFile, { force: true });
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

/**
 * BATCH-65 — a value a custom decoder returned, as text for a harness-error reason. It must never
 * throw: the reason is what names the decoder, and a throw here would replace it with the
 * formatter's own message (`Do not know how to serialize a BigInt`). `JSON.stringify` throws on a
 * BigInt and on a circular object, so a BigInt is written with its `n` suffix, and anything
 * `JSON.stringify` cannot write falls back to `String`, then to the value's type.
 */
function describeDecodedValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return `a value of type ${typeof value}`;
    }
  }
}

/**
 * Shape a decoded transcript the way the gth-agent target shapes its run stats: `tools` is the
 * de-duplicated names of every requested and executed tool in first-seen order (core's set), and
 * every payload and argument string is capped with core's own {@link capToolResultText}.
 */
function shapeOutcome(
  decoded: DecodedTranscript,
  captureMaxBytes: number,
  recordToolCallArgs: boolean
): {
  tools: string[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
} {
  const tools = [
    ...new Set([
      ...decoded.toolCalls.map((call) => call.name),
      ...decoded.toolResults.map((result) => result.name),
    ]),
  ];
  const calls: ToolCallRecord[] = decoded.toolCalls.map((call) => {
    const capped = capToolResultText(call.args, captureMaxBytes);
    return {
      name: call.name,
      ...(call.id ? { id: call.id } : {}),
      args: capped.text,
      ...(capped.truncated ? { argsTruncated: true, argsOriginalBytes: capped.originalBytes } : {}),
    };
  });
  const toolResults: ToolResultRecord[] = decoded.toolResults.map((result) => {
    const capped =
      result.content !== undefined ? capToolResultText(result.content, captureMaxBytes) : undefined;
    return {
      name: result.name,
      isError: result.isError,
      ...(capped !== undefined ? { content: capped.text } : {}),
      ...(capped?.truncated
        ? { contentTruncated: true, contentOriginalBytes: capped.originalBytes }
        : {}),
    };
  });
  return { tools, toolCalls: evalToolCallRecords(calls, recordToolCallArgs), toolResults };
}

/**
 * Build the `RunCellFn` for a command target. The cell id is the case id — a command suite has no
 * identity matrix — so each run takes its case's own timeout.
 */
export function buildCommandRunCell(
  target: CommandTarget,
  suite: Pick<EvalSuite, 'cases'>,
  decoder: TranscriptDecoder,
  options: CommandRunnerOptions = {}
): RunCellFn {
  const timeouts = new Map(suite.cases.map((evalCase) => [evalCase.id, evalCase.timeoutMs]));
  const spawnCommand = options.spawnCommand ?? runCommandProcess;
  const captureMaxBytes = options.captureMaxBytes ?? TOOL_RESULT_CONTENT_CAP;

  const workspaces = new Map(
    suite.cases.flatMap((evalCase) =>
      evalCase.workspace !== undefined ? [[evalCase.id, evalCase.workspace] as const] : []
    )
  );
  const checks = new Map(
    suite.cases.flatMap((evalCase) =>
      evalCase.workspaceChecks !== undefined
        ? [[evalCase.id, evalCase.workspaceChecks] as const]
        : []
    )
  );

  const gradeWhen = new Map(
    suite.cases.flatMap((evalCase) =>
      evalCase.gradeWhen !== undefined ? [[evalCase.id, new Set(evalCase.gradeWhen)] as const] : []
    )
  );

  /**
   * BATCH-62 — is a run that ended on `outcome` (not `success`) graded instead of being a harness
   * error? Only when BOTH hold:
   *
   * - **The case's effective `grade_when` lists it.** Resolved at parse: the case's list, else the
   *   target's, and a case's `[]` leaves nothing listed. An unlisted outcome stays a harness error,
   *   because harness error is the right default: a run that did not finish is not evidence unless
   *   the suite author says it is.
   * - **The process exited with a code.** A run killed by a signal (`exitCode: null`) is never
   *   graded, even when what it printed before dying happens to end on a listed result: the process
   *   did not end the run, something outside it did. A timed-out run never gets here at all.
   *
   * The exit code's VALUE is deliberately not consulted. Claude Code exits 1 on `error_max_turns`,
   * so requiring 0 would make the key useless for the case it exists for, and the transcript's own
   * result line is the more specific statement of how the run ended. A `success` transcript with a
   * non-zero exit is not an outcome and never reaches here: it stays a harness error, as before.
   *
   * A decoder THROW is never graded either, whatever the list says (it never reaches here): output
   * without a terminal result is not a run that ended on anything.
   */
  function gradedEnding(outcome: string, caseId: string, exitCode: number | null): boolean {
    if (exitCode === null) return false;
    return gradeWhen.get(caseId)?.has(outcome) === true;
  }

  const runAndDecode = async (
    cell: MatrixCell,
    timeoutMs: number,
    cwd: string,
    childEnv: NodeJS.ProcessEnv
  ): Promise<CellRunOutcome> => {
    let run: CommandRunResult;
    try {
      run = await spawnCommand({
        argv: target.argv,
        prompt: cell.content,
        promptDelivery: target.prompt,
        timeoutMs,
        cwd,
        env: childEnv,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // Before any branch below can return: every way a finished run is judged keeps its transcript.
    options.onTranscript?.(cell, run);

    const stderrTail = tail(run.stderr);
    const withStderr = (reason: string): string =>
      stderrTail ? `${reason}; stderr: ${stderrTail}` : reason;

    if (run.timedOut) {
      return {
        ok: false,
        error: withStderr(
          `the command did not finish within its ${timeoutMs}ms timeout and its process tree was ` +
            'killed'
        ),
      };
    }

    let decoded: DecodedTranscript | undefined;
    let decodeError: string | undefined;
    try {
      decoded = decoder(run.stdout);
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }

    // BATCH-62 — `outcome` is part of the public decoder contract, so a custom decoder's value is
    // checked before it can decide anything: it must be a non-empty string. Anything else is a
    // harness error naming the decoder, whatever `grade_when` lists and whatever the exit code,
    // because a malformed outcome cannot be matched against the list honestly; treating it as
    // `success` would grade a run the decoder was trying to say did not finish.
    if (decoded !== undefined && 'outcome' in decoded && decoded.outcome !== undefined) {
      const value: unknown = decoded.outcome;
      if (typeof value !== 'string' || value.trim() === '') {
        return {
          ok: false,
          error: withStderr(
            `transcript "${target.transcript}" returned an invalid outcome ` +
              `${JSON.stringify(value) ?? String(value)}: it must be a non-empty string naming ` +
              'how the run ended, or left out for a run that finished'
          ),
        };
      }
    }

    // BATCH-65 — `costUsd` is part of the same public contract, and is checked the same way: a value
    // that is set must be a finite, non-negative number of US dollars. Anything else is a harness
    // error naming the decoder. Dropping it would make the printed total silently cover fewer cases
    // than the decoder's author expects; keeping it would put NaN, Infinity or a negative into a sum.
    if (decoded !== undefined && 'costUsd' in decoded && decoded.costUsd !== undefined) {
      const value: unknown = decoded.costUsd;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return {
          ok: false,
          error: withStderr(
            `transcript "${target.transcript}" returned an invalid costUsd ` +
              `${describeDecodedValue(value)}: it must be a finite, non-negative ` +
              'number of US dollars, or left out when the agent reports no cost'
          ),
        };
      }
    }
    // Carried on both graded paths below, including a run graded under `grade_when`: a capped run
    // still spent money, and leaving it out would understate the total.
    const cost = decoded?.costUsd !== undefined ? { costUsd: decoded.costUsd } : {};

    // BATCH-62 — a run that reached a terminal result but did not end in `success`. See
    // `gradedEnding` for when it is graded; otherwise it is the harness error the decoder used to
    // throw, with the decoder's own sentence as the reason, so a suite without `grade_when` reports
    // exactly what it did before the key existed.
    const outcome =
      decoded?.outcome !== undefined && decoded.outcome !== 'success' ? decoded.outcome : undefined;
    if (decoded !== undefined && outcome !== undefined) {
      if (gradedEnding(outcome, cell.id, run.exitCode)) {
        return {
          ok: true,
          outcome,
          answer: decoded.answer,
          ...(decoded.tokensInput !== undefined ? { tokensInput: decoded.tokensInput } : {}),
          ...(decoded.tokensOutput !== undefined ? { tokensOutput: decoded.tokensOutput } : {}),
          ...cost,
          ...shapeOutcome(decoded, captureMaxBytes, options.recordToolCallArgs === true),
        };
      }
      const reason: unknown = decoded.outcomeReason;
      decodeError =
        typeof reason === 'string' && reason.trim() !== ''
          ? reason
          : `the run ended with outcome "${outcome}"`;
      decoded = undefined;
    }

    if (run.exitCode !== 0) {
      const decoderSays = decodeError ? `; transcript "${target.transcript}": ${decodeError}` : '';
      return {
        ok: false,
        error: withStderr(`the command exited with code ${run.exitCode}${decoderSays}`),
      };
    }
    if (decoded === undefined) {
      return {
        ok: false,
        error: withStderr(`transcript "${target.transcript}" could not be decoded: ${decodeError}`),
      };
    }

    return {
      ok: true,
      answer: decoded.answer,
      ...(decoded.tokensInput !== undefined ? { tokensInput: decoded.tokensInput } : {}),
      ...(decoded.tokensOutput !== undefined ? { tokensOutput: decoded.tokensOutput } : {}),
      ...cost,
      ...shapeOutcome(decoded, captureMaxBytes, options.recordToolCallArgs === true),
    };
  };

  return async (cell) => {
    const timeoutMs = timeouts.get(cell.id) ?? COMMAND_TARGET_DEFAULT_TIMEOUT_MS;
    const baseEnv = options.env ?? env;
    const spec = workspaces.get(cell.id);
    // No workspace: the directory gth was started in and gth's own environment object, unchanged.
    if (spec === undefined) {
      return runAndDecode(cell, timeoutMs, options.cwd ?? getCurrentWorkDir(), baseEnv);
    }

    let dir: string;
    try {
      dir = createWorkspaceDir(cell.id, spec);
    } catch (error) {
      return {
        ok: false,
        error: `the workspace could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const keep = options.keepWorkspaces === true;
    if (keep) {
      // Reported as the case starts, not when it ends: a case that hangs and is interrupted never
      // reaches `finally`, and that is the run whose workspace is most worth looking at.
      options.onWorkspaceKept?.(cell.id, dir);
    } else {
      liveWorkspaces.add(dir);
      installExitHook();
    }
    try {
      const childEnv = buildWorkspaceEnv(spec, dir, baseEnv);
      const setupError = await runWorkspaceSetup(spec, dir, baseEnv, childEnv, timeoutMs);
      if (setupError !== undefined) return { ok: false, error: setupError };
      // BATCH-63 — only the command starts in the workspace's `cwd`; setup ran, and the `after`
      // steps and file checks below run, in `dir`. A `cwd` that is missing or leads outside the
      // workspace is a harness error: the agent never ran, so there is nothing to grade.
      let commandDir: string;
      try {
        commandDir = resolveWorkspaceCwd(dir, spec.cwd);
      } catch (error) {
        return {
          ok: false,
          error: `${error instanceof Error ? error.message : String(error)}; the case's command was not started`,
        };
      }
      const ran = await runAndDecode(cell, timeoutMs, commandDir, childEnv);
      const outcome = await gradeWorkspace(
        checks.get(cell.id),
        spec,
        dir,
        baseEnv,
        childEnv,
        timeoutMs,
        ran
      );
      return options.inspectWorkspace
        ? await options.inspectWorkspace({ caseId: cell.id, dir }, outcome)
        : outcome;
    } finally {
      if (!keep) {
        liveWorkspaces.delete(dir);
        try {
          removeWorkspaceDir(dir);
        } catch (error) {
          options.onWorkspaceRemoveFailed?.(
            cell.id,
            dir,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
  };

  /**
   * Run the workspace's `setup` steps in order. Returns the harness-error reason of the first step
   * that cannot start, exits non-zero or times out, or `undefined` when every step succeeded.
   */
  async function runWorkspaceSetup(
    spec: CommandWorkspace,
    dir: string,
    baseEnv: NodeJS.ProcessEnv,
    childEnv: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<string | undefined> {
    const notStarted = "; the case's command was not started";
    for (const [index, step] of spec.setup.entries()) {
      const name = `workspace setup step ${index + 1} of ${spec.setup.length} ("${step.run}")`;
      const started = await startWorkspaceStep(step.argv, name, notStarted, spec, dir, {
        baseEnv,
        childEnv,
        timeoutMs,
      });
      if ('reason' in started) return started.reason;
      const { run } = started;
      if (run.exitCode !== 0) {
        return `${name} exited with code ${run.exitCode}${notStarted}${stderrSuffix(run)}`;
      }
    }
    return undefined;
  }

  /**
   * Start one workspace-side step — a BATCH-58 `setup` step or a BATCH-59 `after` step — the one way
   * both are started: its parse-time argv with the tokens expanded per element, through the spawn
   * seam (no shell, the tree kill and the exit hook), with the workspace as its cwd, the workspace's
   * `env`, NO prompt (appending the case's prompt to `git init` would make it a directory name), and
   * the case's own timeout. One helper, so a change to how such a step starts cannot reach one kind
   * and miss the other.
   *
   * Returns the run, or the harness-error reason when the step could not start or outlived the
   * timeout; `suffix` is added to that reason before the stderr tail. What a finished run MEANS is
   * the caller's: a `setup` step must exit 0, an `after` step is compared with its expectation.
   */
  async function startWorkspaceStep(
    argv: readonly string[],
    name: string,
    suffix: string,
    spec: CommandWorkspace,
    dir: string,
    envs: { baseEnv: NodeJS.ProcessEnv; childEnv: NodeJS.ProcessEnv; timeoutMs: number }
  ): Promise<{ run: CommandRunResult } | { reason: string }> {
    let run: CommandRunResult;
    try {
      run = await spawnCommand({
        argv: expandSetupArgv(argv, spec, dir, envs.baseEnv),
        prompt: '',
        promptDelivery: 'none',
        timeoutMs: envs.timeoutMs,
        cwd: dir,
        env: envs.childEnv,
      });
    } catch (error) {
      return {
        reason: `${name} ${error instanceof Error ? error.message : String(error)}${suffix}`,
      };
    }
    if (run.timedOut) {
      return {
        reason:
          `${name} did not finish within the case's ${envs.timeoutMs}ms timeout and its process ` +
          `tree was killed${suffix}${stderrSuffix(run)}`,
      };
    }
    return { run };
  }

  /**
   * BATCH-59 — grade the case's workspace assertions while the workspace still exists, and return
   * the outcome to report.
   *
   * ## The order, and what each result becomes
   *
   * - **Nothing is graded on a run that failed.** An `ok: false` outcome (the command timed out,
   *   exited non-zero, or printed no transcript) is already a harness error, and what it left on
   *   disk is a half-finished run.
   * - **`file_contains`, then `must_not_exist`, then the `after` steps, in order.** The file checks
   *   go first because an `after` step can change the tree (a build, a formatter); they grade what
   *   the AGENT left.
   * - **A check that does not hold is an assertion failure:** its reason goes on
   *   `workspaceFailures`, the outcome stays `ok: true`, and the eval runner adds it to the cell's
   *   `reasons`, so the cell FAILs (exit 1).
   * - **A workspace entry the file checks could not read** (EACCES and the like) is a harness
   *   error, for the same reason as the next item: the check never looked.
   * - **An `after` step that cannot start, or outlives the case's timeout, is a harness error**
   *   (`ok: false`, exit 2), exactly as a `setup` step is: the check never ran, so there is no
   *   result to grade, and reporting the case as failed would charge the harness's trouble to the
   *   agent. Later steps are not run.
   *
   * Every step runs even when an earlier one did not match, so one run reports every check that
   * did not hold.
   */
  async function gradeWorkspace(
    caseChecks: WorkspaceChecks | undefined,
    spec: CommandWorkspace,
    dir: string,
    baseEnv: NodeJS.ProcessEnv,
    childEnv: NodeJS.ProcessEnv,
    timeoutMs: number,
    outcome: CellRunOutcome
  ): Promise<CellRunOutcome> {
    if (caseChecks === undefined || !outcome.ok) return outcome;
    let failures: string[];
    try {
      failures = [
        ...checkFileContains(dir, caseChecks.fileContains),
        ...checkMustNotExist(dir, caseChecks.mustNotExist),
      ];
    } catch (error) {
      // An entry the check could not look at (EACCES and the like) is a harness error: see
      // WorkspaceUnreadableError. Anything else is a bug, and is left to propagate.
      if (error instanceof WorkspaceUnreadableError) return { ok: false, error: error.message };
      throw error;
    }
    for (const [index, step] of caseChecks.after.entries()) {
      const result = await runAfterStep(step, index, caseChecks.after.length, spec, dir, {
        baseEnv,
        childEnv,
        timeoutMs,
      });
      if (result.harnessError !== undefined) return { ok: false, error: result.harnessError };
      if (result.failure !== undefined) failures.push(result.failure);
    }
    return failures.length > 0 ? { ...outcome, workspaceFailures: failures } : outcome;
  }

  /**
   * BATCH-59 — run one `after` step and compare its result.
   *
   * It is started exactly as a `setup` step is, by {@link startWorkspaceStep}.
   *
   * ## A crashed check must never pass on its output
   *
   * Under `equals` or `contains`, a step that exits non-zero FAILS, naming the exit code and the
   * tail of its stderr, and its stdout is not compared. `git status --porcelain` run outside a
   * repository prints nothing to stdout and exits 128; compared on its output alone, that is
   * exactly `equals: ""`, the "nothing changed" assertion, and it would pass on a workspace where
   * git never looked. Only `exit_code` reads the exit code as the answer.
   *
   * stdout is compared trimmed, with Windows line endings read as `\n`, so a check written once
   * reads the same output on every platform.
   */
  async function runAfterStep(
    step: WorkspaceAfterStep,
    index: number,
    count: number,
    spec: CommandWorkspace,
    dir: string,
    envs: { baseEnv: NodeJS.ProcessEnv; childEnv: NodeJS.ProcessEnv; timeoutMs: number }
  ): Promise<{ harnessError?: string; failure?: string }> {
    const name = `after step ${index + 1} of ${count} ("${step.run}")`;
    const started = await startWorkspaceStep(step.argv, name, '', spec, dir, envs);
    if ('reason' in started) return { harnessError: started.reason };
    const { run } = started;
    const withStderr = (reason: string): string => `${reason}${stderrSuffix(run)}`;
    const expectation = step.expect;
    if (expectation.kind === 'exit_code') {
      return run.exitCode === expectation.code
        ? {}
        : {
            failure: withStderr(
              `${name}: expected exit code ${expectation.code}, got ` +
                (run.exitCode === null ? 'none (it was killed by a signal)' : `${run.exitCode}`)
            ),
          };
    }
    if (run.exitCode !== 0) {
      return {
        failure: withStderr(
          `${name} exited with code ${run.exitCode === null ? 'none (killed by a signal)' : run.exitCode}, ` +
            `so its output was not compared (${expectation.kind})`
        ),
      };
    }
    const stdout = run.stdout.replace(/\r\n/g, '\n').trim();
    if (expectation.kind === 'equals') {
      return stdout === expectation.value
        ? {}
        : {
            failure: `${name}: expected stdout ${JSON.stringify(expectation.value)}, got ${JSON.stringify(clip(stdout))}`,
          };
    }
    return stdout.includes(expectation.value)
      ? {}
      : {
          failure: `${name}: stdout does not contain ${JSON.stringify(expectation.value)}; it was ${JSON.stringify(clip(stdout))}`,
        };
  }
}

/** `; stderr: <tail>` for a run that printed to stderr, or nothing. */
function stderrSuffix(run: CommandRunResult): string {
  const stderrTail = tail(run.stderr);
  return stderrTail ? `; stderr: ${stderrTail}` : '';
}

/** At most {@link STDERR_TAIL_CHARS} characters of `text`, from its start, for a reason. */
function clip(text: string): string {
  return text.length > STDERR_TAIL_CHARS ? `${text.slice(0, STDERR_TAIL_CHARS)}…` : text;
}
