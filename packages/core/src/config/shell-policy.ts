/**
 * @packageDocumentation
 * Shell / dev-tools policy: the {@link GthDevToolsConfig} type plus all the resolvers
 * that interpret it (shell enablement, timeouts, output budget, per-command dev-tools
 * selection), and — since CFG-26 — the {@link ApprovalsConfig} block and its context-aware
 * resolver {@link resolveApprovals} (approval mode, the AI rater, the allow-list knobs).
 *
 * CFG-18 — the dev/shell tools are now configured through the unified {@link GthConfig.builtInTools}
 * registry (`string[] | Record<string, boolean | BuiltInToolConfig>`), NOT the removed per-command
 * `commands.<mode>.devTools` key. {@link GthDevToolsConfig} is therefore no longer an on-disk shape:
 * it is the internal, resolved view that {@link getEffectiveDevToolsConfig} builds from the effective
 * `builtInTools` registry, and that {@link GthDevToolkit} + the shell accessors below consume. This
 * keeps the toolkit/accessor surface stable while the single config surface is `builtInTools`.
 */
import { type GthCommand, StatusLevel } from '#src/core/types.js';
import type { GthConfig } from '#src/config/types.js';
import { isTTY } from '#src/utils/systemUtils.js';

/**
 * CFG-18 — the per-tool config object carried as a value in the {@link GthConfig.builtInTools}
 * registry (the object form's values, alongside a bare boolean that enables/force-disables a tool).
 * Heterogeneous by tool, modelled as one permissive object (all fields optional) rather than a
 * discriminated union so the registry can carry every tool's shape:
 * - the fixed dev-command tools (`run_tests`/`run_lint`/`run_build`/`run_single_test`) read
 *   {@link command} — the shell command to run; its presence enables the tool;
 * - `run_shell_command` reads the EXT-9/12 execution knobs ({@link enabled}/{@link timeout}/
 *   {@link maxOutputBytes});
 * - `gth_grep` reads {@link fileSet} (GS2-51) — which corpus to search;
 * - a plain built-in tool (`gth_checklist`, `gth_web_fetch`, …) reads {@link enabled} (or is
 *   toggled with a bare boolean in the registry).
 *
 * CFG-26 — the APPROVAL knobs (`allowlist`, `persistAllowlist`, `judge`, `yolo`) are gone from
 * here and live in the top-level {@link ApprovalsConfig}. They were fields of the object shared by
 * EVERY built-in tool, so `gth_grep: { yolo: true }` used to validate; approvals are a property of
 * the session, not of one tool's registry entry.
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
  /**
   * `gth_grep` (GS2-51): which corpus the content-search tool scans, applied consistently to BOTH
   * execution engines (native ripgrep and the in-process JS fallback):
   * - `gitignore` (DEFAULT) — respect `.gitignore`/`.ignore` and skip hidden dot-files. This is the
   *   best code-search UX and is already ripgrep's own default, so rg-present machines see NO
   *   behaviour change; only the corpus *selection* becomes explicit.
   * - `all` — scan everything except the noise dirs (`node_modules`/`dist`/`.git`/`.idea`); for rg
   *   this passes `--no-ignore --hidden`.
   *
   * Example: `{ "builtInTools": { "gth_grep": { "fileSet": "all" } } }`.
   *
   * NOTE: under `gitignore` the JS fallback is a best-effort approximation (skip noise dirs + hidden
   * dot-files); it does NOT parse arbitrary `.gitignore` rules the way rg does. See the residual
   * rg-vs-JS divergence note in `gthGrepTool.ts`.
   */
  fileSet?: 'gitignore' | 'all';
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
 *     "run_shell_command": { "timeout": 300000 }
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
   * `code` mode emits the tool (still GATED behind the approval gate — the absent-config
   * default NEVER implies bypass); `exec` / `ask --write` keep it OFF. An EXPLICIT value
   * always wins: `shell: false` (or `{ enabled: false }`) is a hard escape hatch that fully
   * disables it even in `code`. Accepts a bare boolean or an `{ enabled }` object.
   *
   * Because the model chooses the command, every invocation is gated behind the CFG-26
   * approvals gate (LangChain `humanInTheLoopMiddleware`, wired via deepagents' `interruptOn`)
   * UNLESS `approvals.mode: "bypass"` turns the gate off. The gate — not string-filtering — is
   * the guardrail, so the command is passed through verbatim (pipes / `$` / `;` are all
   * legitimate).
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
   * `approvals.mode: "bypass"`; that floor is not configurable.
   *
   * On-disk (CFG-18) these live on the `run_shell_command` entry of `builtInTools`, e.g.
   * `{ "builtInTools": { "run_shell_command": true } }` or
   * `{ "builtInTools": { "run_shell_command": { "timeout": 300000, "maxOutputBytes": 200000 } } }`.
   *
   * CFG-26 — the approval knobs that used to live here (`allowlist`, `persistAllowlist`,
   * `judge`, `yolo`) moved to the top-level `approvals` block ({@link ApprovalsConfig}); read
   * them through {@link resolveApprovals}, never from this object.
   */
  shell?:
    | boolean
    | {
        enabled?: boolean;
        timeout?: number;
        maxOutputBytes?: number;
      };
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
 * Build the internal, resolved {@link GthDevToolsConfig} from a normalized `builtInTools` registry:
 * the fixed dev-command tools read their `command` string, and `run_shell_command` maps to the
 * `shell` view the accessors below consume (CFG-26: the approval knobs are no longer here — they
 * live in the top-level `approvals` block, resolved by {@link resolveApprovals}). Returns `undefined` when the registry
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
      };
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

/* -------------------------------------------------------------------------------------------- *
 * CFG-26 — the `approvals` block: mode + AI rater + allow-list.
 * -------------------------------------------------------------------------------------------- */

/**
 * The user-facing approval posture.
 * - `auto` — the AI rater rates every gated call; `safe` runs, below the escalate threshold the
 *   rejection reason goes back to the model, at/above it the human is asked, `critical` is refused.
 * - `ask` — every gated call prompts the human (a configured rater acts as an advisor only).
 * - `bypass` — no gate (the honest name for the retired `yolo`). The exec-time hardline floor
 *   still refuses catastrophic commands.
 */
export type ApprovalMode = 'auto' | 'ask' | 'bypass';

/** How strict the RATING PROMPT's tier definitions are. Never changes the action mapping. */
export type RaterStrictness = 'lenient' | 'standard' | 'strict';

/**
 * The only model-vs-human routing knob: a verdict at/above this tier asks the human, below it the
 * reason is returned to the model. `critical` is deliberately absent — it always rejects.
 */
export type RaterEscalateThreshold = 'caution' | 'danger' | 'never';

/** On-disk `approvals.rater` object form. `false`/`true` are handled by {@link ApprovalsConfig}. */
export interface RaterConfig {
  /** Identity profile the rater runs under (strict resolution, GS2-62). Omitted = the main model. */
  profile?: string;
  /** Rating-prompt strictness. Default {@link DEFAULT_RATER_STRICTNESS}. */
  strictness?: RaterStrictness;
  /** Escalate-to-human threshold. Default {@link DEFAULT_RATER_ESCALATE}. */
  escalate?: RaterEscalateThreshold;
}

/**
 * On-disk `approvals` block (root or per command). Replaces the retired
 * `builtInTools.run_shell_command.{yolo,judge,allowlist,persistAllowlist}` knobs.
 */
export interface ApprovalsConfig {
  mode?: ApprovalMode;
  /** `false` disables the rater; `true`/an object enables it. Absent = on iff `mode` is `auto`. */
  rater?: boolean | RaterConfig;
  /** EXT-9 Tier-2 scoped allow-list master switch. Default `true`. */
  allowlist?: boolean;
  /** Persist `always`-scoped grants to the project file. Default `true`. */
  persistAllowlist?: boolean;
}

/** The rater half of {@link ResolvedApprovals}, with every default already applied. */
export interface ResolvedRater {
  enabled: boolean;
  profile?: string;
  strictness: RaterStrictness;
  escalate: RaterEscalateThreshold;
}

/** The fully-defaulted approvals posture for one command in one context. */
export interface ResolvedApprovals {
  mode: ApprovalMode;
  rater: ResolvedRater;
  allowlist: boolean;
  persistAllowlist: boolean;
}

/**
 * CFG-26 — how many command prefixes the allow-list holds, for the `/approvals` display.
 * `always: undefined` means the persisted store has not been loaded (or persistence is off) —
 * rendered `—` rather than a misleading `0`, since a display must never create the store.
 */
export interface AllowlistCounts {
  session: number;
  always: number | undefined;
}

/** Default rating-prompt strictness when `approvals.rater.strictness` is absent. */
export const DEFAULT_RATER_STRICTNESS: RaterStrictness = 'standard';

/** Default escalate-to-human threshold when `approvals.rater.escalate` is absent. */
export const DEFAULT_RATER_ESCALATE: RaterEscalateThreshold = 'danger';

/**
 * The commands whose default posture is the INTERACTIVE row of the defaults matrix — the surfaces
 * where a human is present at a terminal to answer a prompt. Everything else (`exec`/`ask`/
 * `review`/`pr` one-shots and the `api` AG-UI/ACP servers) takes the fail-closed row.
 */
const INTERACTIVE_APPROVAL_COMMANDS: ReadonlySet<string> = new Set(['code', 'chat']);

/**
 * CFG-26 — resolve the effective {@link ResolvedApprovals} for the active command, applying the
 * spec's defaults matrix when no `approvals` key exists:
 *
 * | Context | Effective default |
 * |---|---|
 * | Interactive `code`/`chat` (TTY) | `mode: auto`, rater on (main model), `standard`, `danger` |
 * | One-shot `exec`/`ask`/`review`/`pr` | rater off, `ask` semantics — non-TTY stays fail-closed |
 * | AG-UI / ACP servers (`api`) | same as one-shot: rater off, fail-closed |
 *
 * "Fail-closed" is not implemented here: it is the runner's existing rule that a pending tool call
 * with NO approval handler is REJECTED (never auto-approved). This resolver only says the posture
 * is `ask`; with no TTY handler wired, `ask` therefore rejects.
 *
 * Precedence: a per-command `approvals` block REPLACES the root one wholesale (no deep merge),
 * mirroring `builtInTools` in {@link getEffectiveDevToolsConfig}. Defaults are applied HERE, at
 * the read site, rather than in `DEFAULT_CONFIG` — so the effective-config snapshot the `/config`
 * panel renders never churns (à la GS2-34 `injectModelContext` / GS2-63 `output.header`).
 *
 * The rater is on when `approvals.rater` is explicitly set to anything but `false`, and otherwise
 * exactly when the effective mode is `auto` — Mari's rule that **auto-mode exists only where the
 * rater does**. (`mode: "auto"` + `rater: false` is rejected by the schema refinement, so the two
 * can never disagree.)
 *
 * @param command The active command; selects the matrix row and the per-command block.
 * @param options.interactive Override the context detection. Omitted = the command is an
 *   interactive one AND we are on a TTY. Pass it explicitly in tests and from callers that already
 *   know (a TUI session, a server).
 */
export function resolveApprovals(
  config: Pick<GthConfig, 'commands' | 'approvals'> | undefined,
  command: GthCommand | undefined,
  options?: { interactive?: boolean }
): ResolvedApprovals {
  const interactive =
    options?.interactive ??
    (command !== undefined && INTERACTIVE_APPROVAL_COMMANDS.has(command) && isTTY());

  const perCommand = command
    ? (config?.commands as Record<string, { approvals?: ApprovalsConfig }> | undefined)?.[command]
        ?.approvals
    : undefined;
  const raw = perCommand ?? config?.approvals;

  const mode: ApprovalMode = raw?.mode ?? (interactive ? 'auto' : 'ask');

  const raterSetting = raw?.rater;
  const raterObject: RaterConfig | undefined =
    raterSetting && typeof raterSetting === 'object' ? raterSetting : undefined;
  const raterEnabled =
    raterSetting === false ? false : raterSetting !== undefined ? true : mode === 'auto';

  return {
    mode,
    rater: {
      enabled: raterEnabled,
      profile: raterObject?.profile,
      strictness: raterObject?.strictness ?? DEFAULT_RATER_STRICTNESS,
      escalate: raterObject?.escalate ?? DEFAULT_RATER_ESCALATE,
    },
    allowlist: raw?.allowlist ?? true,
    persistAllowlist: raw?.persistAllowlist ?? true,
  };
}

/** A status notice a backend should surface after resolving the shell approval gate. */
export interface ShellApprovalGateNotice {
  /** Severity to pass to the agent's `statusUpdate` callback. */
  level: StatusLevel;
  /** The user-facing message. */
  message: string;
}

/** The resolved shell approval-gate policy: whether to gate, and what to tell the user. */
export interface ShellApprovalGateDecision {
  /**
   * Whether `run_shell_command` must be wired behind the per-command approval interrupt
   * (langchain's `humanInTheLoopMiddleware` — installed directly on the lean backend, via
   * deepagents' `interruptOn` on the deep one).
   */
  gateShell: boolean;
  /** The notice to surface, when this configuration warrants one. */
  notice?: ShellApprovalGateNotice;
}

/**
 * EXT-52 — the ONE shell approval-gate policy both agent backends resolve
 * (`GthLangChainAgent` = lean/default, `GthDeepAgent` = deep). It decides whether the opt-in
 * `run_shell_command` tool is gated behind the per-command approval interrupt, and which status
 * notice (if any) the backend should surface. The backends differ only in HOW they install the
 * interrupt; the policy and its user-facing copy live here so the two can never drift (and so a
 * later rename of this config surface has one place to change).
 *
 * CFG-26 — how `approvals.mode` (the retired `run_shell_command.yolo` is now `mode: "bypass"`)
 * interacts with gating:
 *   • In interactive `code` mode the tool stays GATED even under `bypass`, so the runner's session
 *     mode governs it and `/approvals ask` can restore the per-command prompt mid-session.
 *     `GthAgentRunner.init` seeds that session mode from config, so the user still sees no prompt
 *     by default; the interactive event/stream path drains the interrupt and approves silently.
 *   • In non-interactive modes (`exec` / `ask --write`) a single-shot run does not drain
 *     interrupts, so `bypass` keeps the tool UNGATED (it runs inline without suspending),
 *     preserving prior behaviour. There is no slash-command surface there to toggle anyway.
 *   • Under `auto` and `ask` the tool is gated; the difference (rater-mediated vs always-prompt)
 *     is decided later, in `GthAgentRunner.decideToolApproval`.
 *   • With the shell tool disabled — or on a non-dev-tools command (chat/api/…) — nothing is gated
 *     and nothing is announced.
 *
 * Shell enablement itself is resolved through {@link getEffectiveDevToolsConfig} +
 * {@link isShellToolEnabled}, so the gate stays in lockstep with where `GthDevToolkit` actually
 * emits the tool; the posture comes from {@link resolveApprovals}, so this and the runner can
 * never disagree about what mode is in force.
 */
export function resolveShellApprovalGate(
  config: Pick<GthConfig, 'commands' | 'builtInTools' | 'askWriteMode' | 'approvals'> | undefined,
  command: GthCommand | undefined
): ShellApprovalGateDecision {
  const devTools = getEffectiveDevToolsConfig(config, command);
  const shellEnabled = isShellToolEnabled(devTools, command);
  const isInteractive = command === 'code';
  // The gate question is only about `bypass`; resolve the mode in the command's own context so an
  // explicit config value wins and the context default applies otherwise.
  //
  // NOTE: `interactive` is pinned to "is this the `code` command", NOT to the TTY, so the gate (and
  // its notice) is deterministic and a piped `gth code` under `bypass` stays GATED exactly as
  // before. `GthAgentRunner.init` resolves the SESSION posture with the TTY-aware default, so on a
  // NON-TTY `code` run with no `approvals` config this notice can say `auto` while the session
  // resolves to `ask` (fail-closed, since no approval handler is wired there anyway). CFG-26 Task 2
  // should render the status bar from the runner's live posture, not from this notice.
  const { mode } = resolveApprovals(config, command, { interactive: isInteractive });
  const gateShell = shellEnabled && (mode !== 'bypass' || isInteractive);

  if (gateShell && mode === 'bypass') {
    return {
      gateShell,
      notice: {
        level: StatusLevel.INFO,
        message:
          'Shell tool (run_shell_command) auto-approved by config (approvals.mode: bypass). ' +
          'Type /approvals ask to require per-command approval.',
      },
    };
  }
  if (gateShell && mode === 'auto') {
    return {
      gateShell,
      notice: {
        level: StatusLevel.INFO,
        message:
          'Shell tool (run_shell_command) gated by the AI rater (approvals.mode: auto); ' +
          'risky commands are still escalated to you.',
      },
    };
  }
  if (gateShell) {
    return {
      gateShell,
      notice: {
        level: StatusLevel.INFO,
        message: 'Shell tool (run_shell_command) enabled with per-command approval.',
      },
    };
  }
  if (shellEnabled) {
    return {
      gateShell,
      notice: {
        level: StatusLevel.WARNING,
        message:
          'Shell tool (run_shell_command) enabled in bypass mode: commands run WITHOUT confirmation.',
      },
    };
  }
  return { gateShell };
}
