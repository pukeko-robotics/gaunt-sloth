/**
 * @packageDocumentation
 * Shell / dev-tools policy: the {@link GthDevToolsConfig} type plus all the resolvers
 * that interpret it (shell enablement, timeouts, output budget, allow-list, the EXT-10
 * LLM-as-judge gate, and per-command dev-tools selection).
 *
 * CFG-18 — the dev/shell tools are now configured through the unified {@link GthConfig.builtInTools}
 * registry (`string[] | Record<string, boolean | BuiltInToolConfig>`), NOT the removed per-command
 * `commands.<mode>.devTools` key. {@link GthDevToolsConfig} is therefore no longer an on-disk shape:
 * it is the internal, resolved view that {@link getEffectiveDevToolsConfig} builds from the effective
 * `builtInTools` registry, and that {@link GthDevToolkit} + the shell accessors below consume. This
 * keeps the toolkit/accessor surface stable while the single config surface is `builtInTools`.
 */
import type { GthCommand } from '#src/core/types.js';
import type { GthConfig, LLMConfig } from '#src/config/types.js';

/**
 * CFG-18 — the per-tool config object carried as a value in the {@link GthConfig.builtInTools}
 * registry (the object form's values, alongside a bare boolean that enables/force-disables a tool).
 * Heterogeneous by tool, modelled as one permissive object (all fields optional) rather than a
 * discriminated union so the registry can carry every tool's shape:
 * - the fixed dev-command tools (`run_tests`/`run_lint`/`run_build`/`run_single_test`) read
 *   {@link command} — the shell command to run; its presence enables the tool;
 * - `run_shell_command` reads the EXT-9/10/12 knobs ({@link enabled}/{@link timeout}/
 *   {@link maxOutputBytes}/{@link allowlist}/{@link persistAllowlist}/{@link judge}/{@link yolo} —
 *   `yolo` is the folded former `shellYolo`);
 * - a plain built-in tool (`gth_checklist`, `gth_web_fetch`, …) reads {@link enabled} (or is
 *   toggled with a bare boolean in the registry).
 */
export interface BuiltInToolConfig {
  /**
   * Enable / force-disable this tool. For `run_shell_command` the resolution is `enabled ?? default`
   * (EXT-12: default ON in `code` mode, OFF elsewhere), so an object entry WITHOUT `enabled` still
   * defaults ON in `code`; `enabled: false` is the hard escape hatch that disables it even in `code`.
   * For a plain built-in tool, `enabled: false` removes it from the loaded set.
   */
  enabled?: boolean;
  /** The shell command for a fixed dev-command tool (`run_tests`/`run_lint`/`run_build`/`run_single_test`). */
  command?: string;
  /** `run_shell_command`: per-command wall-clock timeout (ms). See {@link SHELL_DEFAULT_TIMEOUT_MS}. */
  timeout?: number;
  /** `run_shell_command`: captured-output byte budget. See {@link SHELL_DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /** `run_shell_command`: EXT-9 Tier-2 scoped allow-list master switch (default `true`). */
  allowlist?: boolean;
  /** `run_shell_command`: persist `always`-scoped approvals to the project file (default `true`). */
  persistAllowlist?: boolean;
  /** `run_shell_command`: EXT-10 LLM-as-judge safety gate (default OFF). */
  judge?:
    | boolean
    | {
        enabled?: boolean;
        autoApproveLow?: boolean;
        blockHigh?: boolean;
        model?: LLMConfig;
      };
  /**
   * `run_shell_command`: opt out of the per-command approval prompt — the explicit "yolo" bypass
   * (folded former top-level `shellYolo`). Dangerous by design; off by default. Example:
   * `{ "run_shell_command": { "yolo": true } }`.
   */
  yolo?: boolean;
}

/**
 * CFG-18 — the widened `builtInTools` setting. Either the legacy `string[]` (each named tool
 * enabled) or a registry keyed by tool name whose values **enable** (`true`), **force-disable**
 * (`false`), or **configure** ({@link BuiltInToolConfig}) each tool. This single key replaces the
 * former split of `builtInTools: string[]` (which tools are on) + per-command `devTools` (how each
 * dev/shell tool is configured).
 *
 * Example — keep the checklist, add web fetch, and configure the shell:
 * ```json
 * { "builtInTools": {
 *     "gth_checklist": true,
 *     "gth_web_fetch": true,
 *     "run_shell_command": { "timeout": 300000, "judge": { "enabled": true } }
 * } }
 * ```
 * Turn the (code-mode default-on) shell OFF: `{ "builtInTools": { "run_shell_command": false } }`.
 */
export type BuiltInToolsSetting = string[] | Record<string, boolean | BuiltInToolConfig>;

/**
 * The fixed dev-command tools: each maps a `command` string (from its {@link BuiltInToolConfig})
 * to a run_* tool emitted by {@link GthDevToolkit}.
 */
export const DEV_COMMAND_TOOL_NAMES = [
  'run_tests',
  'run_lint',
  'run_build',
  'run_single_test',
] as const;

/** The opt-in general-purpose shell tool name. */
export const SHELL_TOOL_NAME = 'run_shell_command';

/**
 * All dev/shell tool names carried in the {@link GthConfig.builtInTools} registry. These are emitted
 * by {@link GthDevToolkit} via the dev-tools bucket, NOT loaded as plain built-in tools — so
 * `getBuiltInTools` skips them (a `run_shell_command` entry in `builtInTools` is legitimate, not an
 * "unknown built-in tool").
 */
export const DEV_TOOL_NAMES: readonly string[] = [...DEV_COMMAND_TOOL_NAMES, SHELL_TOOL_NAME];

/**
 * Normalize the widened {@link BuiltInToolsSetting} to a plain lookup keyed by tool name. The array
 * form maps each name to `true`; the object form passes through unchanged; absent → `{}`.
 */
export function normalizeBuiltInTools(
  builtInTools: BuiltInToolsSetting | undefined
): Record<string, boolean | BuiltInToolConfig> {
  if (!builtInTools) return {};
  if (Array.isArray(builtInTools)) {
    const out: Record<string, boolean | BuiltInToolConfig> = {};
    for (const name of builtInTools) out[name] = true;
    return out;
  }
  return builtInTools;
}

/**
 * Whether a plain built-in tool's registry entry is enabled: a bare `true`, or an object entry that
 * is not `{ enabled: false }` (configuring a tool enables it). A bare `false` force-disables it.
 * Dev/shell tools ({@link DEV_TOOL_NAMES}) are NOT resolved through this — they go through
 * {@link getEffectiveDevToolsConfig} / {@link isShellToolEnabled}.
 */
export function isBuiltInToolEntryEnabled(value: boolean | BuiltInToolConfig | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return value.enabled !== false;
}

/**
 * Config for {@link GthDevToolkit} — the INTERNAL, resolved dev/shell view (CFG-18: no longer an
 * on-disk shape; built from the {@link GthConfig.builtInTools} registry by
 * {@link getEffectiveDevToolsConfig}). Tools are not applied when the config is empty. Only active
 * in `code`/`exec` mode (and `ask --write`).
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
   * On-disk (CFG-18) these live on the `run_shell_command` entry of `builtInTools`, e.g.
   * `{ "builtInTools": { "run_shell_command": true } }` or
   * `{ "builtInTools": { "run_shell_command": { "timeout": 300000, "maxOutputBytes": 200000 } } }`.
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
   * On-disk (CFG-18) this is the `yolo` knob of the `run_shell_command` entry, e.g.
   * `{ "builtInTools": { "run_shell_command": { "yolo": true } } }`.
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
 * EXT-12 / CFG-18 — default-resolution is `enabled ?? default`. An EXPLICIT `enabled` always wins
 * (a bare boolean, or the object form's `enabled`), so `shell: false` / `{ enabled: false }` remains
 * a hard escape hatch that fully disables the tool. When `enabled` is ABSENT — whether `shell` is
 * undefined OR an object that omits `enabled` (e.g. `{ timeout: 300000 }`, i.e. a
 * `{ "run_shell_command": { "timeout": 300000 } }` registry entry) — the per-mode default applies:
 * ON in `code` mode (still gated — the per-command approval interrupt is wired separately and is NOT
 * bypassed by this), OFF everywhere else (`exec`, `ask --write`, …). This is the CFG-18 change from
 * the old `enabled === true` object semantics: configuring the shell no longer silently turns it off.
 * The default is `code`-mode only because `code` is the interactive agentic-coding surface where a
 * TTY can answer the approval prompt; the absent-config default never implies yolo.
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
  // Object form: `enabled ?? default` — an object without `enabled` still defaults ON in `code`.
  if (shell && typeof shell === 'object') return shell.enabled ?? command === 'code';
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
 * Build the internal, resolved {@link GthDevToolsConfig} from a normalized `builtInTools` registry:
 * the fixed dev-command tools read their `command` string, and `run_shell_command` maps to the
 * `shell` (+ `shellYolo`) view the accessors below consume. Returns `undefined` when the registry
 * carries no dev/shell entry at all, so callers treat it exactly like an unset `devTools` (the
 * `code`-mode shell default still applies downstream via {@link isShellToolEnabled}).
 */
function devToolsConfigFromRegistry(
  registry: Record<string, boolean | BuiltInToolConfig>
): GthDevToolsConfig | undefined {
  const resolved: GthDevToolsConfig = {};
  let hasAny = false;

  for (const name of DEV_COMMAND_TOOL_NAMES) {
    const entry = registry[name];
    const cmd = entry && typeof entry === 'object' ? entry.command : undefined;
    if (typeof cmd === 'string' && cmd.length > 0) {
      resolved[name] = cmd;
      hasAny = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(registry, SHELL_TOOL_NAME)) {
    const entry = registry[SHELL_TOOL_NAME];
    if (typeof entry === 'boolean') {
      resolved.shell = entry;
    } else if (entry && typeof entry === 'object') {
      resolved.shell = {
        enabled: entry.enabled,
        timeout: entry.timeout,
        maxOutputBytes: entry.maxOutputBytes,
        allowlist: entry.allowlist,
        persistAllowlist: entry.persistAllowlist,
        judge: entry.judge,
      };
      if (entry.yolo !== undefined) resolved.shellYolo = entry.yolo;
    }
    hasAny = true;
  }

  return hasAny ? resolved : undefined;
}

/**
 * Resolve the {@link GthDevToolsConfig} that applies to the active command from the unified
 * {@link GthConfig.builtInTools} registry (CFG-18 — replaces the removed per-command `devTools`).
 * Mirrors the per-command selection used by `builtInToolsConfig.getDefaultTools`: `exec` →
 * `commands.exec`, `ask --write` → `commands.ask`, `code` → `commands.code`; `undefined` elsewhere
 * (the dev/shell tools are inert there). The effective registry for the scope is the per-command
 * `builtInTools` if set, else the root `builtInTools` — matching `getEffectiveConfig`'s replace
 * merge. Shared in core so the runner's allow-list/judge gates stay in lockstep with where the
 * shell tool is actually emitted.
 */
export function getEffectiveDevToolsConfig(
  config: Pick<GthConfig, 'commands' | 'builtInTools' | 'askWriteMode'> | undefined,
  command: GthCommand | undefined
): GthDevToolsConfig | undefined {
  if (!config) return undefined;
  const askWrite = command === 'ask' && config.askWriteMode === true;
  const cmdConfig =
    command === 'exec'
      ? config.commands?.exec
      : askWrite
        ? config.commands?.ask
        : command === 'code'
          ? config.commands?.code
          : undefined;
  // Only the do-the-job commands (code/exec/ask --write) carry dev/shell tools.
  if (command !== 'exec' && command !== 'code' && !askWrite) return undefined;
  const effective = cmdConfig?.builtInTools ?? config.builtInTools;
  return devToolsConfigFromRegistry(normalizeBuiltInTools(effective));
}
