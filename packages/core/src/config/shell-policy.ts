/**
 * @packageDocumentation
 * Shell / dev-tools policy: the {@link GthDevToolsConfig} type plus all the resolvers
 * that interpret it (shell enablement, timeouts, output budget, allow-list, the EXT-10
 * LLM-as-judge gate, and per-command dev-tools selection). Extracted verbatim from the
 * former `config.ts` god-file; behaviour is unchanged.
 */
import type { GthCommand } from '#src/core/types.js';
import type { GthConfig, LLMConfig } from '#src/config/types.js';

/**
 * Config for {@link GthDevToolkit}.
 * Tools are not applied when config is not provided.
 * Only available in `code`/`exec` mode (and `ask --write`).
 */
export interface GthDevToolsConfig {
  /**
   * Optional shell command to run tests.
   * Not applied when config is not provided.
   */
  run_tests?: string;
  /**
   * Optional shell command to run static analysis (lint).
   * Not applied when config is not provided.
   */
  run_lint?: string;
  /**
   * Optional shell command to run the build.
   * Not applied when config is not provided.
   */
  run_build?: string;
  /**
   * Optional shell command to run a single test file.
   * Supports command interpolation with the `${testPath}` placeholder.
   * Example: "npm test -- ${testPath}" or "jest ${testPath}"
   * Example: "npm test" - the test will simply be appended
   * Not applied when config is not provided.
   */
  run_single_test?: string;
  /**
   * Opt-in general-purpose shell tool (`run_shell_command`). Unlike the fixed
   * `run_*` commands above, this lets the agent run ARBITRARY shell commands it
   * composes itself — the agentic-coding escape hatch the deep agent otherwise
   * lacks (it can read/write files but not run commands).
   *
   * EXT-12 — default: ON in `code` mode, OFF elsewhere. When this is ABSENT/undefined,
   * `code` mode emits the tool (still GATED behind the per-command approval prompt — the
   * absent-config default NEVER implies yolo); `exec` / `ask --write` keep it OFF. An
   * EXPLICIT value always wins: `shell: false` (or `{ enabled: false }`) is a hard escape
   * hatch that fully disables it even in `code`. Accepts a bare boolean or an
   * `{ enabled }` object for symmetry with future per-tool options.
   *
   * Because the model chooses the command, every invocation is gated behind a
   * per-command human confirmation dialog (LangChain `humanInTheLoopMiddleware`,
   * wired via deepagents' `interruptOn`) UNLESS {@link shellYolo} bypasses it.
   * The confirmation — not string-filtering — is the guardrail, so the command
   * is passed through verbatim (pipes / `$` / `;` are all legitimate).
   *
   * The object form also tunes the EXT-9 Tier-1 hardening applied to every run
   * (these have safe defaults so bare `shell: true` is already hardened):
   * - `timeout`: per-command wall-clock limit in MILLISECONDS before the child
   *   (and its process group) is killed. Default {@link SHELL_DEFAULT_TIMEOUT_MS}.
   * - `maxOutputBytes`: byte budget for the captured output returned to the model
   *   (head + tail window; the middle is dropped and the full output spilled to a
   *   temp file). Default {@link SHELL_DEFAULT_MAX_OUTPUT_BYTES}. Live terminal
   *   streaming is never capped.
   *
   * A hardcoded hardline blocklist of catastrophic commands (rm -rf /, mkfs, dd
   * to a block device, fork bomb, shutdown/reboot, …) is refused even under
   * {@link shellYolo}; that floor is not configurable.
   *
   * Example: `{ "shell": true }`,
   * `{ "shell": { "enabled": true, "timeout": 300000, "maxOutputBytes": 200000 } }`.
   *
   * The object form additionally accepts EXT-9 Tier-2 allow-list knobs:
   * - `allowlist`: master switch for the scoped approval allow-list (session +
   *   persisted `always`). Default `true` — once a command is approved at `session`/
   *   `always` scope, flag-variants of the same classified operation auto-approve
   *   without re-prompting. Set `false` to require fresh approval for every command.
   * - `persistAllowlist`: whether `always`-scoped approvals are written to the project
   *   allow-list file (`.gsloth/.gsloth-settings/shell-allowlist.json`). Default `true`.
   *   When `false`, an `always` decision behaves like `session` (in-memory only).
   *
   * The object form also accepts the EXT-10 LLM-as-judge safety gate (default OFF):
   * - `judge`: an opt-in, tiered auto-approve pre-filter that vets each `run_shell_command`
   *   with a lightweight judge model BEFORE the human prompt. It auto-approves clearly-safe
   *   commands (fatigue reducer), escalates the rest to the existing human prompt, and may
   *   reject clearly-catastrophic ones. Default OFF because it costs one LLM call per command.
   *   Accepts a bare boolean (`judge: true` → defaults: auto-approve low, escalate medium/high,
   *   judge model = `config.llm`) or an object:
   *     - `enabled`: turn the gate on.
   *     - `autoApproveLow`: auto-approve `low`-risk, statically-resolvable commands. Default true.
   *     - `blockHigh`: reject clearly-catastrophic (`high` + destructive) verdicts WITHOUT
   *       prompting. Default false (conservative; EXT-9's hardline floor already refuses truly
   *       catastrophic commands at exec time).
   *     - `model`: an optional separate (e.g. cheaper) judge model config. Defaults to `config.llm`.
   *   Hardening (always on when the judge runs): the command is normalized + XML-tagged as
   *   UNTRUSTED input in the judge prompt; a judge throw/timeout/parse-failure fails CLOSED
   *   (escalate, never auto-approve); commands whose target can't be statically resolved
   *   (shell composition / substitution / redirection) and interpreter+script invocations that
   *   leak ALL_CAPS env vars are NEVER auto-approved.
   */
  shell?:
    | boolean
    | {
        enabled?: boolean;
        timeout?: number;
        maxOutputBytes?: number;
        allowlist?: boolean;
        persistAllowlist?: boolean;
        judge?:
          | boolean
          | {
              enabled?: boolean;
              autoApproveLow?: boolean;
              blockHigh?: boolean;
              model?: LLMConfig;
            };
      };
  /**
   * Opt-out of the per-command confirmation dialog for {@link shell}
   * (`run_shell_command`) — the explicit "yolo" bypass. When `true` AND `shell`
   * is enabled, the shell tool runs without any approval interrupt: the model's
   * commands execute immediately. Dangerous by design; off by default.
   *
   * Example: `{ "shell": true, "shellYolo": true }`.
   */
  shellYolo?: boolean;
}

/**
 * Default per-command shell timeout (ms) when {@link GthDevToolsConfig.shell}
 * does not specify one. ~120s suits typical build/test/git steps without
 * hanging the agent forever on a stuck command.
 */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Default byte budget for shell output captured into the ToolMessage returned to
 * the model (head + tail window). ~100KB keeps a noisy log from blowing the
 * context window; the full output is spilled to a temp file when this is exceeded.
 */
export const SHELL_DEFAULT_MAX_OUTPUT_BYTES = 100_000;

/**
 * Normalize the {@link GthDevToolsConfig.shell} opt-in (bare boolean or
 * `{ enabled }`) to a plain boolean. Centralized so the toolkit (tool emission)
 * and the deep agent (interrupt wiring) agree on what "shell enabled" means.
 *
 * EXT-12 — default-resolution: an EXPLICIT value always wins (a bare boolean, or the
 * object form's `enabled`), so `shell: false` / `{ enabled: false }` remains a hard
 * escape hatch that fully disables the tool. Only when `shell` is ABSENT/undefined does
 * the per-mode default apply: in `code` mode the shell tool is ON by default (still
 * gated — the per-command approval interrupt is wired separately and is NOT bypassed by
 * this), and OFF everywhere else (`exec`, `ask --write`, …) to preserve prior behaviour.
 * The default is `code`-mode only because `code` is the interactive agentic-coding surface
 * where a TTY can answer the approval prompt; the absent-config default never implies yolo.
 *
 * @param command The active command, so the absent-config default can be scoped to `code`.
 *   Omit (or pass a non-`code` command) to keep the historical OFF-by-default behaviour.
 */
export function isShellToolEnabled(
  devTools: GthDevToolsConfig | undefined,
  command?: GthCommand | undefined
): boolean {
  const shell = devTools?.shell;
  if (typeof shell === 'boolean') return shell;
  if (shell && typeof shell === 'object') return shell.enabled === true;
  // Absent/undefined shell: ON by default for `code` mode (gated), OFF elsewhere.
  return command === 'code';
}

/**
 * Resolve the per-command shell timeout (ms) from config, falling back to
 * {@link SHELL_DEFAULT_TIMEOUT_MS}. Only the object form can override it; a bare
 * `shell: true` uses the default. Non-positive / non-finite values are ignored.
 */
export function getShellTimeoutMs(devTools: GthDevToolsConfig | undefined): number {
  const shell = devTools?.shell;
  if (shell && typeof shell === 'object' && typeof shell.timeout === 'number') {
    if (Number.isFinite(shell.timeout) && shell.timeout > 0) return shell.timeout;
  }
  return SHELL_DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve the captured-output byte budget from config, falling back to
 * {@link SHELL_DEFAULT_MAX_OUTPUT_BYTES}. Only the object form can override it.
 * Non-positive / non-finite values are ignored.
 */
export function getShellMaxOutputBytes(devTools: GthDevToolsConfig | undefined): number {
  const shell = devTools?.shell;
  if (shell && typeof shell === 'object' && typeof shell.maxOutputBytes === 'number') {
    if (Number.isFinite(shell.maxOutputBytes) && shell.maxOutputBytes > 0) {
      return shell.maxOutputBytes;
    }
  }
  return SHELL_DEFAULT_MAX_OUTPUT_BYTES;
}

/**
 * Whether the EXT-9 Tier-2 scoped allow-list is active. Default `true`; only the object
 * form's `allowlist: false` disables it (a bare `shell: true` keeps it on). When off, the
 * runner prompts for every `run_shell_command` regardless of prior approvals.
 */
export function isShellAllowlistEnabled(devTools: GthDevToolsConfig | undefined): boolean {
  const shell = devTools?.shell;
  if (shell && typeof shell === 'object' && shell.allowlist === false) return false;
  return true;
}

/**
 * Whether `always`-scoped approvals are persisted to the project allow-list file. Default
 * `true`; only the object form's `persistAllowlist: false` disables persistence (an
 * `always` decision then behaves as `session`).
 */
export function isShellAllowlistPersisted(devTools: GthDevToolsConfig | undefined): boolean {
  const shell = devTools?.shell;
  if (shell && typeof shell === 'object' && shell.persistAllowlist === false) return false;
  return true;
}

/**
 * Resolved settings for the EXT-10 LLM-as-judge safety gate.
 */
export interface ShellJudgeSettings {
  /** Whether the judge gate runs at all. */
  enabled: boolean;
  /** Auto-approve `low`-risk, statically-resolvable commands (the fatigue reducer). */
  autoApproveLow: boolean;
  /** Reject clearly-catastrophic (`high` + destructive) verdicts without prompting. */
  blockHigh: boolean;
  /** Optional separate judge model config; when absent the runner uses `config.llm`. */
  model?: LLMConfig;
}

/**
 * Whether the EXT-10 LLM-as-judge safety gate is enabled for the given dev-tools config.
 * Default OFF (only the object form's `judge` truthy enables it), mirroring
 * {@link isShellToolEnabled}. A bare `shell: true` keeps the judge OFF — it costs an LLM call
 * per command and must be opted into explicitly.
 */
export function isShellJudgeEnabled(devTools: GthDevToolsConfig | undefined): boolean {
  const shell = devTools?.shell;
  if (!shell || typeof shell !== 'object') return false;
  const judge = shell.judge;
  if (typeof judge === 'boolean') return judge;
  if (judge && typeof judge === 'object') return judge.enabled === true;
  return false;
}

/**
 * Resolve the EXT-10 judge gate settings from a dev-tools config, applying safe defaults
 * (auto-approve low, do NOT block high). `enabled` reflects {@link isShellJudgeEnabled}.
 */
export function getShellJudgeSettings(devTools: GthDevToolsConfig | undefined): ShellJudgeSettings {
  const enabled = isShellJudgeEnabled(devTools);
  const shell = devTools?.shell;
  const judge =
    shell && typeof shell === 'object' && shell.judge && typeof shell.judge === 'object'
      ? shell.judge
      : undefined;
  return {
    enabled,
    autoApproveLow: judge?.autoApproveLow ?? true,
    blockHigh: judge?.blockHigh ?? false,
    model: judge?.model,
  };
}

/**
 * Resolve the {@link GthDevToolsConfig} that applies to the active command, mirroring the
 * per-command selection in `builtInToolsConfig.getDefaultTools` (which is what actually emits
 * the dev tools) and `GthDeepAgent.getEffectiveDevToolsConfig`: `exec` → `commands.exec`,
 * `ask --write` → `commands.ask`, `code` → `commands.code`; `undefined` elsewhere (the
 * toolkit is inert there). Shared in core so the runner's allow-list gate stays in lockstep
 * with where the shell tool is actually emitted.
 */
export function getEffectiveDevToolsConfig(
  config: Pick<GthConfig, 'commands' | 'askWriteMode'> | undefined,
  command: GthCommand | undefined
): GthDevToolsConfig | undefined {
  if (!config) return undefined;
  const askWrite = command === 'ask' && config.askWriteMode === true;
  if (command === 'exec') return config.commands?.exec?.devTools;
  if (askWrite) return config.commands?.ask?.devTools;
  if (command === 'code') return config.commands?.code?.devTools;
  return undefined;
}
