/**
 * @module core/shell/ShellCommandFailedError
 *
 * The typed error a `run_*` shell/dev tool throws when a command did NOT exit cleanly
 * (non-zero exit code, or killed for exceeding the timeout). It carries the FULL model-facing
 * body so a softening middleware can hand the model the exact observation it saw before — the
 * only change being that the tool result's status flips to `'error'` (→ `isError` → the ✗ glyph).
 *
 * Canonical home is **core** so BOTH agents can recognise a shell failure without violating the
 * `agent → core` dependency direction:
 *  - the deep agent (`code` mode, `@gaunt-sloth/agent` `GthDeepShellExitSoftening`) and
 *  - the lean agent (`exec` / `ask --write`, core `GthLangChainAgent` `GthLeanShellExitSoftening`).
 *
 * The throw site (`GthDevToolkit.executeCommand`) lives in the `agent` package and re-exports this
 * class, so its `throw new ShellCommandFailedError(...)` is one and the same type both agents catch.
 */

/**
 * A `run_*` command that did NOT exit cleanly (non-zero exit code, or was killed for exceeding the
 * timeout). Carries the FULL model-facing body text ({@link output}) so a softening middleware can
 * hand the model the exact same observation it saw before — the only change is the tool result's
 * status flips to `'error'`, which drives the ✗ (`isError`) glyph.
 *
 * `executeCommand` previously `resolve()`d on a non-zero exit, so the LangChain `ToolMessage` stayed
 * `status: 'success'` and every failure rendered a ✓. Throwing this typed error instead lets each
 * agent's softening middleware convert it into an error `ToolMessage`. A clean exit (`code === 0`)
 * still `resolve()`s; a spawn-level `child.on('error')` still rejects with a plain `Error`.
 */
export class ShellCommandFailedError extends Error {
  /** The full model-facing body (command echo + `<COMMAND_OUTPUT>` + the failure/timeout tail). */
  readonly output: string;
  /** The process exit code; `null` when the command was killed (timeout) and never exited cleanly. */
  readonly exitCode: number | null;
  /** The exact command string that was executed. */
  readonly command: string;
  /** The run_* tool name that invoked the command (e.g. `run_tests`, `run_shell_command`). */
  readonly toolName: string;

  constructor(params: {
    output: string;
    exitCode: number | null;
    command: string;
    toolName: string;
  }) {
    // Use the full body as the Error message so any generic logger/handler still surfaces the
    // real command output rather than an opaque wrapper string.
    super(params.output);
    this.name = 'ShellCommandFailedError';
    this.output = params.output;
    this.exitCode = params.exitCode;
    this.command = params.command;
    this.toolName = params.toolName;
  }
}

/**
 * Recognise a {@link ShellCommandFailedError} for the softening middleware in either agent.
 *
 * Prefers a plain `instanceof` (both agents share this one core module, so the class identity is
 * the same), but falls back to a STRUCTURAL check keyed on `name === 'ShellCommandFailedError'`
 * plus the carried fields. The structural arm is deliberate defence against a dual-package /
 * realm-boundary hazard: if the error ever crossed a module boundary that broke `instanceof`, we
 * would otherwise silently rethrow a real shell failure and regress the ✗ signal. Every field the
 * softener reads (`output`) is asserted so a narrowed value is safe to use.
 */
export function isShellCommandFailedError(e: unknown): e is ShellCommandFailedError {
  if (e instanceof ShellCommandFailedError) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ShellCommandFailedError' &&
    typeof (e as { output?: unknown }).output === 'string' &&
    typeof (e as { command?: unknown }).command === 'string' &&
    typeof (e as { toolName?: unknown }).toolName === 'string'
  );
}
