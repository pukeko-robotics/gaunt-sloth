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
 * ## What BATCH-58 needs from here
 *
 * {@link CommandSpawnRequest} carries `cwd` and `env` per call, so a per-case workspace only has to
 * supply them; nothing here assumes one directory for the whole suite.
 *
 * @module
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandTarget,
  EvalSuite,
  RunCellFn,
  ToolCallRecord,
  ToolResultRecord,
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
import { env, getCurrentWorkDir, getProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { evalToolCallRecords } from '#src/commands/evalToolCallRecords.js';

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
  promptDelivery: CommandTarget['prompt'];
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
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Kill every live command's process tree. The `'exit'` listener; exported for its spec. */
export function killLiveCommandChildren(): void {
  for (const child of liveChildren) killProcessGroup(child, 'SIGKILL');
  liveChildren.clear();
}

function trackLiveChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killLiveCommandChildren);
  }
}

/**
 * Start the command once and collect its output. Rejects only when the process cannot be started
 * (an unknown command, for one); every other outcome resolves, timed out or not.
 */
export function runCommandProcess(request: CommandSpawnRequest): Promise<CommandRunResult> {
  const [command, ...baseArgs] = request.argv;
  const viaArg = request.promptDelivery === 'arg';
  const args = viaArg ? [...baseArgs, request.prompt] : baseArgs;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: request.cwd,
      env: request.env,
      // With `arg`, stdin is closed: a `-p` CLI that finds an open pipe may wait on it forever.
      stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

    if (!viaArg && child.stdin) {
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
    : resolve(getProjectDir(), dirname(suiteReadPath), spec);
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
  /** The child's environment; gth's own unless set. */
  env?: NodeJS.ProcessEnv;
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
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

  return async (cell) => {
    const timeoutMs = timeouts.get(cell.id) ?? COMMAND_TARGET_DEFAULT_TIMEOUT_MS;
    let run: CommandRunResult;
    try {
      run = await spawnCommand({
        argv: target.argv,
        prompt: cell.content,
        promptDelivery: target.prompt,
        timeoutMs,
        cwd: options.cwd ?? getCurrentWorkDir(),
        env: options.env ?? env,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

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
      ...shapeOutcome(decoded, captureMaxBytes, options.recordToolCallArgs === true),
    };
  };
}
