/**
 * @packageDocumentation
 * Shell / dev-tools policy: the {@link GthDevToolsConfig} type plus all the resolvers
 * that interpret it (shell enablement, timeouts, output budget, per-command dev-tools
 * selection), and — since CFG-27 — the {@link ApprovalsConfig} value and its resolver
 * {@link resolveApprovals} (the five-rung ladder, the rater's identity profile, and the declared
 * allow/deny lists).
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
 * CFG-27 — the `approvals` ladder: one ordered set of five rungs, plus the declared lists.
 * -------------------------------------------------------------------------------------------- */

/**
 * CFG-27 (spec §1, §2) — **the ladder**. There is ONE approvals setting and it is a single ordered
 * ladder of five rungs; each rung fully determines behaviour. There are no severity thresholds, no
 * strictness levels and no independent rater on/off switch.
 *
 * | # | Rung | Rater | LLM cost |
 * |---|---|---|---|
 * | 1 | `read-only` | no | none |
 * | 2 | `write` | no | none |
 * | 3 | `auto-safe` | yes | 1 call per gated call |
 * | 4 | `full-auto` | yes | 1–2 calls per gated call |
 * | 5 | `bypass` | no | none |
 *
 * Rungs 1, 2 and 5 are fully deterministic: no model is consulted, so behaviour is reproducible
 * and costs nothing.
 *
 * **`bypass` is NOT a higher-autonomy rung than `full-auto`** (§2.5). Both let the agent act
 * without asking; `bypass` is the same autonomy with the checks removed. The ordering below is the
 * order the rungs are *offered* in, and must never be presented as though `full-auto` were an
 * incomplete `bypass`.
 *
 * Identifiers are kebab-case (§9.1) because the same token must work as a config value, a
 * slash-command argument and a CLI flag — a space breaks the last two. Display names keep their
 * spaces; see {@link APPROVAL_RUNG_LABELS}.
 */
export const APPROVAL_RUNGS = ['read-only', 'write', 'auto-safe', 'full-auto', 'bypass'] as const;

/** One rung of {@link APPROVAL_RUNGS}. */
export type ApprovalRung = (typeof APPROVAL_RUNGS)[number];

/**
 * §9.1 rule / §10 rule 4 — the display spelling of each rung, with spaces. An identifier and a
 * label do not have to match and only one of them has to survive a shell, so user-facing prose
 * uses these and never the kebab-case identifiers.
 */
export const APPROVAL_RUNG_LABELS: Record<ApprovalRung, string> = {
  'read-only': 'Read only',
  write: 'Write',
  'auto-safe': 'Auto safe',
  'full-auto': 'Full auto',
  bypass: 'Bypass',
};

/**
 * §10 — the one sentence shown wherever a rung is chosen or displayed. **Copied verbatim from the
 * specification**; the wording is constrained by four normative rules there (state what the rung
 * PERMITS, state the allow-list carve-out, never claim safety this system cannot deliver, use the
 * display spelling) plus §8.1 (the hardline floor is real but is NEVER advertised — descriptions
 * cite only protections the user can inspect and extend, i.e. the deny list). Do not "improve"
 * these: `auto-safe` in particular MUST keep the sentence saying files are still rewritten and
 * deleted without asking.
 *
 * The only departure from the source text is that §10's markdown emphasis markers (`**not**` in
 * *Full auto*) are dropped, since these strings are rendered as plain terminal copy.
 */
export const APPROVAL_RUNG_DESCRIPTIONS: Record<ApprovalRung, string> = {
  'read-only':
    'Gaunt Sloth may automatically read and list files in the current working folder. It asks ' +
    'for approval for anything else, until you tell it to always allow a command.',
  write:
    'Gaunt Sloth may automatically read, edit, create and delete files in the current working ' +
    'folder. It asks for approval for anything else, until you tell it to always allow a command.',
  'auto-safe':
    'Same as write, plus the auto-rater rates everything else and automatically approves what it ' +
    'rates as safe; anything questionable comes to you. Gaunt Sloth can still rewrite and delete ' +
    'files in your working folder without asking — "safe" means each action is checked for ' +
    'reaching outside that folder or harming your system, not that nothing changes.',
  'full-auto':
    'The auto-rater steers Gaunt Sloth: it decides for itself and does not stop to ask you. This ' +
    'is safer than bypass — the auto-rater still stops the run on a command that reads your keys ' +
    'or passwords, weakens permissions, installs itself to run again later, or hides what it ' +
    'does; it brings anything it cannot undo to you rather than deciding alone; and your deny ' +
    'list still applies — but it is not safe. Gaunt Sloth will change and delete things. Use it ' +
    'where the consequences are recoverable, and put real gates (deployment approvals, ' +
    'two-factor, branch protection) on anything that is not.',
  bypass:
    'No gate. Gaunt Sloth runs whatever it decides to run, without asking and without rating. ' +
    'Only the refusals configured in the deny list in your config still apply.',
};

/** Narrowing type guard for a raw string that may name a rung. */
export function isApprovalRung(value: unknown): value is ApprovalRung {
  return typeof value === 'string' && (APPROVAL_RUNGS as readonly string[]).includes(value);
}

/** The rungs at which every gated call is rated by the model (§2.3, §2.4). */
export function isRatedRung(rung: ApprovalRung): boolean {
  return rung === 'auto-safe' || rung === 'full-auto';
}

/**
 * On-disk `approvals` object form (root or per command). The **scalar form is exactly sugar for
 * `{ mode: <value> }`** (§9.1) — the union exists so the extras have a home when they are needed,
 * not so there are two ways to say the same thing.
 */
export interface ApprovalsObjectConfig {
  /** The rung. Absent = {@link DEFAULT_APPROVAL_RUNG}. */
  mode?: ApprovalRung;
  /**
   * §9.1 — the identity profile the rater runs under, as a **bare name** (strict resolution,
   * GS2-62: a name that does not resolve is a hard config error, never a silent fallback).
   * Omitted = the main model. It is the only rater knob; nesting a one-field object is what this
   * design removed.
   */
  rater?: string;
  /** §3 — declared allow-list: command prefixes the human trusts. Read-only input. */
  allow?: string[];
  /** §3 — declared deny-list: command prefixes never to run. Read-only input; applies under `bypass`. */
  deny?: string[];
}

/** On-disk `approvals` value: the rung on its own, or the object when the extras are needed. */
export type ApprovalsConfig = ApprovalRung | ApprovalsObjectConfig;

/**
 * The fully-defaulted approvals posture for one command. `allow`/`deny` are the **declared**
 * lists straight from config — read-only input that the runner merges with the runtime stores the
 * escalation menu writes, and that is never written back to config (§9.1).
 */
export interface ResolvedApprovals {
  /** The rung in force. */
  rung: ApprovalRung;
  /** Identity profile the rater runs under, or `undefined` for the session model. */
  rater?: string;
  /** Declared allow-list prefixes (§3). Empty when none are declared. */
  allow: string[];
  /** Declared deny-list prefixes (§3). Empty when none are declared. */
  deny: string[];
}

/**
 * CFG-26 — how many command prefixes the allow-list holds, for the `/approvals` display.
 * `always: undefined` means the persisted store has not been loaded — rendered `—` rather than a
 * misleading `0`, since a display must never create the store.
 */
export interface AllowlistCounts {
  session: number;
  always: number | undefined;
}

/**
 * §1.1 — **the default rung is `auto-safe`, everywhere.** It is the default in every interactive
 * context, it does NOT vary with the configured model, and there is no separate non-interactive
 * default. What changes without a human is what an escalation *does* (§6.2: an immediate non-zero
 * exit, never an approval), not which rung the session starts on. A context-dependent default
 * would reintroduce exactly the hidden branching this ladder exists to remove.
 */
export const DEFAULT_APPROVAL_RUNG: ApprovalRung = 'auto-safe';

/** Normalize the scalar/object union to the object form. The scalar is sugar for `{ mode }`. */
function toApprovalsObject(raw: ApprovalsConfig | undefined): ApprovalsObjectConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return { mode: raw };
  return raw;
}

/**
 * CFG-27 — resolve the effective {@link ResolvedApprovals} for the active command.
 *
 * There is no defaults *matrix* any more: §1.1 makes `auto-safe` the default in every context, so
 * this resolver neither detects nor accepts a "context". Precedence is the only thing it decides:
 * a per-command `approvals` value **replaces the root one wholesale** (no merge), mirroring how
 * `builtInTools` resolves in {@link getEffectiveDevToolsConfig}. Defaults are applied HERE, at the
 * read site, rather than in `DEFAULT_CONFIG` — so the effective-config snapshot the `/config`
 * panel renders never churns (à la GS2-34 `injectModelContext` / GS2-63 `output.header`).
 *
 * @param command The active command; selects the per-command block.
 */
export function resolveApprovals(
  config: Pick<GthConfig, 'commands' | 'approvals'> | undefined,
  command: GthCommand | undefined
): ResolvedApprovals {
  const perCommand = command
    ? (config?.commands as Record<string, { approvals?: ApprovalsConfig }> | undefined)?.[command]
        ?.approvals
    : undefined;
  const raw = toApprovalsObject(perCommand ?? config?.approvals);

  return {
    rung: raw?.mode ?? DEFAULT_APPROVAL_RUNG,
    rater: raw?.rater,
    allow: raw?.allow ?? [],
    deny: raw?.deny ?? [],
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
 * CFG-27 — **the tool is gated whenever it is enabled, at every rung including `bypass`.** CFG-26
 * used to leave it UNGATED under `bypass` outside interactive `code`, which the ladder cannot
 * afford: §2.5 makes the declared **deny list the one check `bypass` keeps**, and a deny entry can
 * only fire if the call reaches `GthAgentRunner.decideToolApproval` — an ungated call never does.
 * Gating unconditionally also keeps the rung switchable mid-session (`/approvals <rung>`), since a
 * tool wired without the interrupt cannot be re-gated without rebuilding the agent.
 *
 * What each rung then does is decided in `decideToolApproval`, not here:
 *   • `bypass` — deny list, then approve without prompting or rating.
 *   • `read-only`/`write` — deny list, allow-list, else escalate to the human.
 *   • `auto-safe`/`full-auto` — deny list, allow-list, then the rater.
 *   • With the shell tool disabled — or on a non-dev-tools command (chat/api/…) — nothing is gated
 *     and nothing is announced.
 *
 * Shell enablement itself is resolved through {@link getEffectiveDevToolsConfig} +
 * {@link isShellToolEnabled}, so the gate stays in lockstep with where `GthDevToolkit` actually
 * emits the tool; the posture comes from {@link resolveApprovals}, so this and the runner can
 * never disagree about which rung is in force.
 */
export function resolveShellApprovalGate(
  config: Pick<GthConfig, 'commands' | 'builtInTools' | 'askWriteMode' | 'approvals'> | undefined,
  command: GthCommand | undefined
): ShellApprovalGateDecision {
  const devTools = getEffectiveDevToolsConfig(config, command);
  const gateShell = isShellToolEnabled(devTools, command);
  if (!gateShell) return { gateShell };

  const { rung } = resolveApprovals(config, command);

  if (rung === 'bypass') {
    return {
      gateShell,
      notice: {
        level: StatusLevel.WARNING,
        message:
          'Shell tool (run_shell_command): commands run without asking and without rating ' +
          '(approvals: bypass). Only your deny list still applies — type /approvals auto-safe to ' +
          'rate commands again.',
      },
    };
  }
  if (isRatedRung(rung)) {
    return {
      gateShell,
      notice: {
        level: StatusLevel.INFO,
        message:
          `Shell tool (run_shell_command) rated by the auto-rater (approvals: ${rung}); ` +
          'anything it does not rate safe is still ' +
          (rung === 'auto-safe' ? 'escalated to you.' : 'refused or escalated.'),
      },
    };
  }
  return {
    gateShell,
    notice: {
      level: StatusLevel.INFO,
      message: `Shell tool (run_shell_command) enabled with per-command approval (approvals: ${rung}).`,
    },
  };
}
