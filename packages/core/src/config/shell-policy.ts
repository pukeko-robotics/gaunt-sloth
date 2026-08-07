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
import { isAccessClassGrantedAtRung } from '#src/config/tool-descriptions.js';

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
    'Gaunt Sloth may automatically read, edit, create, move and delete files in the current ' +
    'working folder. It asks for approval for anything else, until you tell it to always allow a ' +
    'command.',
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
 * The rungs that decide a gated call **without a model** — `read-only` and `write` (§2.1, §2.2).
 * Everything they do not auto-grant goes to the human, so these are the two rungs a user picks in
 * order to read and approve every tool call themselves.
 *
 * The complement of {@link isRatedRung} plus `bypass`; written out rather than negated so that a
 * sixth rung would have to be classified deliberately instead of defaulting into this set.
 */
export function isDeterministicRung(rung: ApprovalRung): boolean {
  return rung === 'read-only' || rung === 'write';
}

/**
 * **The one rule: does `rung` gate this tool — i.e. must this call be decided rather than simply
 * run?** Everything else in this area is a projection of this predicate over a set of names.
 *
 * - The shell is gated whenever the shell gate is on, at EVERY rung (`bypass` included, so §2.5's
 *   deny list can still fire — see the `bypass` arm of `GthAgentRunner.decideToolApproval`).
 * - At the two **deterministic** rungs, a tool is gated when the rung's own grant does not cover its
 *   access class ({@link isAccessClassGrantedAtRung}). At `read-only` that leaves only the built-in
 *   READ tools free; at `write`, the built-in read and write tools. The write built-ins, the shell,
 *   deepagents' `execute`, MCP tools and custom/agent-authored tools all escalate to the human.
 * - At `auto-safe`, `full-auto` and `bypass` nothing but the shell is gated. **That split is
 *   deliberate and load-bearing, not tidiness.** At a rated rung a gated non-shell call reaches the
 *   `subject.kind !== 'shell'` arm of `GthAgentRunner.decideToolApproval`, which floors it at
 *   `destructive` and sends it to the human *with no rating call*, because §4.3 keeps the rater on
 *   the shell until [[EXT-30]]. Gating there would silently turn every MCP call at `auto-safe` into
 *   a human prompt — a UX change belonging to EXT-30, not to the two rungs whose published
 *   descriptions this predicate makes true.
 *
 * `gateShell` only ever WIDENS the result. At a deterministic rung the shell is gated by its own
 * (absent) access class if it is bound at all, so `gateShell: false` does not exempt it — an
 * exemption keyed to one tool NAME is the defect class this predicate exists to remove. In practice
 * a disabled shell tool is never bound, so the two agree.
 *
 * **This takes no bound toolset**, which is what lets `GthAgentRunner` ask it about a single
 * arriving call: the runner sees the names the graph registered, and on the deep backend that list
 * omits tools deepagents registers itself. A decision that consulted a bound list would grant
 * `execute` at `read-only` purely because the runner could not see it.
 */
export function isToolGatedAtRung(options: {
  toolName: string;
  rung: ApprovalRung;
  gateShell: boolean;
}): boolean {
  const { toolName, rung, gateShell } = options;
  if (gateShell && toolName === SHELL_TOOL_NAME) return true;
  if (!isDeterministicRung(rung)) return false;
  return !isAccessClassGrantedAtRung(toolName, rung);
}

/**
 * **The LIVE gated set: which bound tools the rung in force actually gates.** What a decision is
 * measured against — the tool descriptions the model reads (§4.5) and the rater's granted-tools
 * summary (§4.4) are both built from this, so neither can tell the model a tool is free while the
 * gate escalates it.
 *
 * **It is NOT what the backends wire into the interrupt.** That is
 * {@link resolveInterruptToolNames}, and the two are different sets on purpose: the interrupt is
 * installed once, at agent init, while `/approvals <rung>` moves the rung underneath it for the rest
 * of the session. A set that carried the rung would be frozen at the rung the session started on —
 * and since the default is `auto-safe`, typing `/approvals read-only` would leave exactly the write
 * tools this design escalates ungated. So the interrupt is wired rung-independently and
 * `GthAgentRunner.decideToolApproval` consults {@link isToolGatedAtRung} against the LIVE rung.
 *
 * **Derived from the bound toolset, never a hand-written list.** A static list of built-ins would
 * leave MCP, custom and agent-authored tools out — the exact tools with no access class and so the
 * exact tools the deterministic rungs must escalate. `boundToolNames` must therefore be the FINAL
 * toolset the graph is handed, including tools the graph builder registers itself (deepagents'
 * filesystem tools, `execute`, `task` and `write_todos` never appear in the array gsloth passes it).
 *
 * Order is stable: the shell first, then bound order. Duplicates are collapsed, so a caller may pass
 * overlapping name sources without deduplicating first.
 */
export function resolveGatedToolNames(options: {
  rung: ApprovalRung;
  gateShell: boolean;
  boundToolNames: readonly string[];
}): readonly string[] {
  const { rung, gateShell, boundToolNames } = options;
  return collectToolNames(gateShell, boundToolNames, (name) =>
    isToolGatedAtRung({ toolName: name, rung, gateShell })
  );
}

/**
 * **The interrupt set: which tool names the backends wire into the approval interrupt.** Every bound
 * tool that ANY rung could gate — the union of {@link resolveGatedToolNames} over
 * {@link APPROVAL_RUNGS}, which in practice is the shell plus every bound tool that is not a
 * built-in READ tool.
 *
 * One derivation for both backends, for the same reason {@link resolveShellApprovalGate} is one: the
 * lean backend installs `humanInTheLoopMiddleware` directly and the deep backend installs the very
 * same middleware through deepagents' `interruptOn`, and a set computed twice is a set that drifts.
 *
 * **Deliberately rung-independent.** The interrupt is installed once, when the agent is built, and
 * `/approvals <rung>` then moves the rung for the rest of the session without rebuilding it. Only a
 * set that covers every rung can survive that: the interrupt fires and
 * `GthAgentRunner.decideToolApproval` decides on the rung in force, which is where the rung has
 * always been read. **Wiring wider does not gate wider** — a call the live rung does not gate is
 * approved there with no rating call and no prompt, so `auto-safe`, `full-auto` and `bypass` behave
 * exactly as they did when the interrupt held the shell alone.
 */
export function resolveInterruptToolNames(options: {
  gateShell: boolean;
  boundToolNames: readonly string[];
}): readonly string[] {
  const { gateShell, boundToolNames } = options;
  return collectToolNames(gateShell, boundToolNames, (name) =>
    APPROVAL_RUNGS.some((rung) => isToolGatedAtRung({ toolName: name, rung, gateShell }))
  );
}

/**
 * Shared body of the two resolvers above: the shell first (when gated), then the bound names the
 * caller's predicate selects, in bound order, deduplicated, with nameless entries dropped.
 */
function collectToolNames(
  gateShell: boolean,
  boundToolNames: readonly string[],
  include: (name: string) => boolean
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  if (gateShell) add(SHELL_TOOL_NAME);
  for (const name of boundToolNames) {
    if (typeof name === 'string' && name.length > 0 && include(name)) add(name);
  }
  return names;
}

/**
 * EXT-71 §3.1 — the **subject** axis of a rule entry, and only that. The schema twin is
 * `APPROVAL_ENTRY_TYPES` in `config/schema.ts`. What holds the two together is
 * `approvalEntrySchema.spec.ts`, where a list of `ApprovalEntry`-typed literals is parsed by that
 * schema: a value either side stops accepting fails there. That is a weaker pin than a direct
 * equality assertion — it catches a narrowing, not a widening on one side alone.
 */
export type ApprovalEntryType = 'shell' | 'tool' | 'mcpTool';

/** EXT-71 §3.1 — the **comparison** axis of a rule entry, and only that. */
export type ApprovalMatcher = 'exact' | 'glob' | 'regexp' | 'hint';

/**
 * §4.7 — the four MCP `ToolAnnotations` hint names, and the whole vocabulary. It is the same list
 * on both sides of the design: what a `hint` pattern may name ({@link ApprovalHintPattern}) and what
 * a user may believe from a server ({@link McpServerApprovalsConfig.trustAnnotations}).
 *
 * **The schema twin `HINT_ANNOTATION_KEYS` in `config/schema.ts` is a deliberate duplicate, and the
 * reason is layering, not oversight.** Neither file may import the other. `schema.ts` states in its
 * own header that it must stay pure and cwd/fs-independent because it feeds `z.toJSONSchema()`, and
 * importing this module would pull `core/types.js` and the whole runtime policy surface into it;
 * importing `schema.ts` here would in turn pull zod into every module that only wanted a policy
 * type. So the vocabulary is written once per layer on purpose — do not "simplify" it by making one
 * import the other.
 *
 * What keeps the two honest instead is the equality assertion in `mcpApprovalsBlock.spec.ts`, which
 * fails the moment they drift. Drift matters in one direction especially: a name the config accepts
 * but the derivation never reads fails silently, and it fails toward trusting. Change one list,
 * change the other.
 */
export const TOOL_ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

/** One of {@link TOOL_ANNOTATION_HINTS}. */
export type ToolAnnotationHint = (typeof TOOL_ANNOTATION_HINTS)[number];

/**
 * EXT-71 §3.1 — a `hint` pattern: the four MCP `ToolAnnotations` booleans, each mapped to the
 * value it must EFFECTIVELY hold (§4.7.1). All named hints must match (AND within the entry);
 * hints not named are unconstrained; `false` is the spelling of negation. At least one must be
 * named — an empty object is a config error, never a match-everything.
 */
export interface ApprovalHintPattern {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Fields every rule entry may carry, whatever its subject. */
interface ApprovalEntryCommon {
  /**
   * §3.2 — whether the rater still reviews a call this entry matched, honored at the rater rungs
   * and inert at the deterministic ones. Valid on EVERY type. Absent takes the §3.2 default: an
   * entry skips the rater only to the extent that it recorded what the rater would have seen, so
   * `shell` + `exact` defaults to `false` and everything else to `true`.
   */
  rate?: boolean;
}

/** §3.1 — a `shell` entry: a command, compared against the normalized command string. */
export interface ShellApprovalEntry extends ApprovalEntryCommon {
  type: 'shell';
  /** `hint` is absent on purpose — a command carries no tool annotations. */
  matcher: 'exact' | 'glob' | 'regexp';
  pattern: string;
}

/** §3.1 — a `tool` entry: a built-in or custom in-process tool, compared against the tool name. */
export interface ToolApprovalEntry extends ApprovalEntryCommon {
  type: 'tool';
  matcher: ApprovalMatcher;
  pattern: string | ApprovalHintPattern;
  /** §4.7.4 — optional exact-match bound on the call's host. Tool subjects only. */
  host?: string;
}

/** §3.1 — an `mcpTool` entry: one server's tool. */
export interface McpToolApprovalEntry extends ApprovalEntryCommon {
  type: 'mcpTool';
  matcher: ApprovalMatcher;
  pattern: string | ApprovalHintPattern;
  /**
   * §4.7.5 — **required**, and the user's own key in `mcpServers`: the only identity a server has
   * that is stable, unique and user-authored. The literal `*` means every server, which is why a
   * configured server may not be named `*`.
   */
  server: string;
  /** §4.7.4 — optional exact-match bound on the call's host. */
  host?: string;
}

/**
 * EXT-71 §3.1 — **one entry** in `allow`, `deny` or `escalate`. All three lists take the same
 * shape; the list an entry sits in decides only what a match DOES (deny over escalate over allow).
 *
 * `type`, `matcher` and `pattern` are always required — no field is inferred and no entry reads
 * two ways. The runtime validator is `approvalEntrySchema` in `config/schema.ts`, which is
 * stricter than TypeScript can be: it rejects unknown fields, an empty or unknown-key `hint`
 * pattern, and a `regexp` that does not compile or is over the length cap.
 */
export type ApprovalEntry = ShellApprovalEntry | ToolApprovalEntry | McpToolApprovalEntry;

/**
 * EXT-70 §4.7.1/§9 — the approvals relationship with ONE MCP server, keyed by the user's own
 * `mcpServers` config key (§4.7.5 — the only identity a server has that is stable, unique and
 * user-authored; nothing a server declares about itself ever participates).
 *
 * `trustAnnotations` names the hints that are BELIEVED from that server. It is a list rather than a
 * boolean because trusting `readOnlyHint` while distrusting `openWorldHint` is a coherent position
 * and the common one, and because a single "trusted server" flag throws that distinction away for
 * nothing. **Absent or empty means what the default means: nothing external is believed** — every
 * hint of that server's collapses to the MCP fail-closed default, so its declarations cannot
 * perturb any rule.
 */
export interface McpServerApprovalsConfig {
  /** §4.7.1 — the hints believed from this server. Absent or empty trusts nothing. */
  trustAnnotations?: ToolAnnotationHint[];
}

/**
 * EXT-70 §4.7/§9 — the `approvals.mcp` block: the per-server relationship, keyed by the user's own
 * `mcpServers` config key.
 *
 * **`defaults` applies to servers NOT named under `servers`** — §9's own gloss. A server that names
 * itself states its own relationship in full, so `{"jira": {}}` trusts nothing however permissive
 * `defaults` is: trust by omission is exactly the failure §4.7.1 exists to prevent, and the fail-
 * closed direction is the one a silent config edit must fall in.
 *
 * A key here is **not** validated against `mcpServers`. A user may write the policy before adding
 * the server, and coupling the two would make config ORDER matter.
 *
 * This block cannot live inside `mcpServers`, which is modelled permissively because it carries
 * runtime objects.
 */
export interface McpApprovalsConfig {
  /** The relationship with every server not named under {@link servers}. */
  defaults?: McpServerApprovalsConfig;
  /** Per-server relationships, keyed by the user's own `mcpServers` config key (§4.7.5). */
  servers?: Record<string, McpServerApprovalsConfig>;
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
  /** §3 — declared allow-list: what the human has trusted. Read-only input. */
  allow?: ApprovalEntry[];
  /** §3 — declared deny-list: what never runs. Read-only input; applies under `bypass` too. */
  deny?: ApprovalEntry[];
  /**
   * §3/§3.2 — declared escalate list: a match always asks the human, whatever the rung would have
   * done, and with no rating call. Read-only input; inert under `bypass` (§2.5).
   */
  escalate?: ApprovalEntry[];
  /**
   * EXT-66 — wall-clock budget (ms) for ONE rating call. Absent = {@link RATER_DEFAULT_TIMEOUT_MS}
   * (30s), which is a hosted-model number: a local rater is knowably slower, and when it runs out
   * of time the gate escalates, so an unreachable timeout turns the permissive rung into one that
   * asks about everything while every layer reports success.
   */
  raterTimeoutMs?: number;
  /**
   * EXT-70 §4.7/§9 — the per-server MCP relationship. Read through
   * `createEffectiveToolAnnotationSource` (`core/approvals/annotations.ts`), which is the ONE place
   * an effective annotation set is derived; nothing else re-reads this block.
   */
  mcp?: McpApprovalsConfig;
}

/** On-disk `approvals` value: the rung on its own, or the object when the extras are needed. */
export type ApprovalsConfig = ApprovalRung | ApprovalsObjectConfig;

/**
 * The fully-defaulted approvals posture for one command. `allow`/`deny`/`escalate` are the
 * **declared** lists straight from config — read-only input that the runner merges with the
 * runtime stores the escalation menu writes, and that is never written back to config (§9.1).
 */
export interface ResolvedApprovals {
  /** The rung in force. */
  rung: ApprovalRung;
  /** Identity profile the rater runs under, or `undefined` for the session model. */
  rater?: string;
  /** Declared allow-list entries (§3.1). Empty when none are declared. */
  allow: ApprovalEntry[];
  /** Declared deny-list entries (§3.1). Empty when none are declared. */
  deny: ApprovalEntry[];
  /** Declared escalate-list entries (§3.1). Empty when none are declared. */
  escalate: ApprovalEntry[];
  /**
   * EXT-66 — wall-clock budget (ms) for one rating call, or `undefined` to let the rater apply
   * `RATER_DEFAULT_TIMEOUT_MS`. Left `undefined` rather than defaulted here so the effective-config
   * snapshot does not churn, exactly as `rater` is.
   */
  raterTimeoutMs?: number;
  /**
   * EXT-70 §4.7 — the declared per-server MCP relationship, or `undefined` when no scope states
   * one (which reads the same as an empty block: nothing external is believed). Left `undefined`
   * rather than defaulted here for the same reason `rater` is — so the effective-config snapshot
   * does not churn.
   */
  mcp?: McpApprovalsConfig;
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
 * EXT-70 §4.7.1 — what one server's annotations are believed on, for display.
 *
 * `configured` says whether {@link server} is a key under `mcpServers` in the loaded config. It is
 * an advisory rather than a validity test: §9 deliberately does NOT check `approvals.mcp` keys
 * against `mcpServers`, so a user may write the policy before adding the server and config ORDER
 * never matters. What it buys interactively is that a mistyped key — which trusts nothing while
 * reading as though it did — can be pointed out rather than swallowed.
 */
export interface McpServerAnnotationTrust {
  /** §4.7.5 — the user's own `mcpServers` config key. */
  server: string;
  /** The hints believed from this server, resolved through `defaults` where it is not named. */
  trusted: ToolAnnotationHint[];
  /** Whether this key names a server in the loaded config's `mcpServers`. */
  configured: boolean;
}

/** EXT-70 §4.7.1 — the whole believed-annotation picture, for the `/approvals` display. */
export interface McpAnnotationTrustView {
  /** §9 — the hints believed from servers NOT named under `servers`. */
  defaults: ToolAnnotationHint[];
  /** Per-server, for every key either the config names or the policy does. */
  servers: McpServerAnnotationTrust[];
}

/**
 * EXT-70 §4.7.1/§4.7.4 — the outcome of believing (or ceasing to believe) hints from one server,
 * so the surface that asked can report exactly what landed and what it costs.
 *
 * **`weakening` is the field that keeps the human un-surprised.** Withdrawing trust pushes a hint
 * back to its fail-closed default, which for three of the four is a *weakening*, so the saved
 * approvals made for that server while the hint was believed will be invalidated (§4.7.4) at the
 * next call to that tool. That has to be said where the user withdraws trust, not only in the
 * notice that arrives later.
 */
export interface McpAnnotationTrustChange extends McpServerAnnotationTrust {
  /** Hints this change started believing (absent from the previous set). */
  added: ToolAnnotationHint[];
  /** Hints this change stopped believing (present in the previous set). */
  removed: ToolAnnotationHint[];
  /**
   * §4.7.4 — the subset of {@link removed} whose withdrawal can weaken an effective set, and
   * therefore invalidate a grant. Empty on a grant of trust, which can never weaken: every
   * weakening move ends at the fail-closed default, and believing a hint only ever moves away
   * from it.
   */
  weakening: ToolAnnotationHint[];
  /**
   * §4.7.4 — the saved approvals for this server that the *resulting* trust actually weakens, each
   * rendered by `describeApprovalEntry`. They are the ones that will be withdrawn, with the §4.7.4
   * notice, at the next call to that tool.
   *
   * **A prediction, never a deletion.** Invalidation stays scoped to the call being decided, because
   * a sweep would read every held grant against a source that can only answer for the tools
   * registered right now — a server that happened to be offline would read as having weakened
   * everything it ever declared, and the grants would go. Listing them is safe where deleting them
   * is not.
   *
   * **It over-reports in two distinct ways, and both are the same trade.** The comparison is each
   * grant's recorded snapshot against the set in force *now*, not the set before this change against
   * the set after it. So (1) a server that is offline when trust moves declares nothing, resolves to
   * the fail-closed constant, and every grant it holds is named; and (2) a grant already weakened
   * for some other reason — an earlier withdrawal, a `tools/list` that took a hint back — is named
   * under whichever withdrawal happens to run next, including one that moved nothing relevant to it.
   * A named grant is therefore one that the trust now in force weakens, which is what the user needs
   * to know; it is not a claim that *this* withdrawal is what weakened it. Reading it as the latter
   * is how a test comes to assert causation the field never promised.
   *
   * Empty is likewise not "nothing is at risk" but "nothing this session can see is": with
   * {@link weakening} non-empty the rule still holds for any grant made while those hints were
   * believed, which is what the notice says in that case. Counted read-only, like
   * {@link AllowlistCounts}: the persisted store is consulted only when it is already loaded.
   */
  invalidates: string[];
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
 * There is no defaults *matrix*: §1.1 makes `auto-safe` the default in every context, so this
 * resolver neither detects nor accepts a "context". Precedence is the only thing it decides, and
 * §9.1 splits it in two:
 *
 * - **The scalars — `mode`, `rater`, `raterTimeoutMs` — are replaced** when the per-command value
 *   states them and **inherited from the root when it does not**. So the scalar sugar
 *   `"code": { "approvals": "bypass" }` is exactly `{ mode: 'bypass' }` merged over the root: it
 *   sets the rung and nothing else.
 * - **`deny` and `escalate` never replace: they CONCATENATE across every scope.** A
 *   command-specific `deny` *adds to* the root's. Removing an inherited prohibition for one command
 *   is deliberately not expressible.
 * - **`allow` is REPLACED when the per-command value states its own, and inherited when it does
 *   not.** A per-command scope may therefore narrow what runs unprompted, and may never widen what
 *   is prohibited.
 * - **`mcp` (EXT-70 §4.7) follows `allow`, not the restrictive lists**: replaced when the
 *   per-command value states it, inherited when it does not. Believing a hint is a PERMISSIVE act
 *   in both directions — it can make an `allow` hint entry fire and can make a `deny` hint entry
 *   stop firing — so it merges the way the permissive list does, and a per-command scope can
 *   narrow the session's trust (`"mcp": {}` believes nothing) but never inherits half of it by
 *   accident. Deep-merging the two scopes' `servers` maps was rejected for the same reason: it
 *   would leave a deliberately distrustful per-command block silently carrying the root's trust.
 *
 * **The two halves differ because the costs differ (§3.1), not for tidiness.** A missed allow entry
 * escalates and a missed deny entry falls through to the rater — neither is an execution — while a
 * too-broad allow entry *runs, unrated and unprompted*. Concatenating the restrictive lists fails
 * toward a prompt; concatenating the permissive one fails toward an execution, and would leave a
 * deliberately restrictive per-command rung with no way to shed the root's standing grants. Do not
 * "regularize" these three into one policy: the direction each list fails in is the whole design.
 *
 * On the restrictive side the pressure runs the other way (§11.1f). Were the per-command value to
 * replace the root wholesale, the friendliest spelling of "stop asking me about `code`" would also
 * delete every `deny` entry — at the one rung where the deny list and the §8 floor are the only
 * checks left. A prohibition a nested config key can quietly delete is not a hardline.
 *
 * Concatenation order cannot change any outcome (`resolveApprovalRules` consults every deny entry
 * before any escalate entry and every escalate entry before any allow entry), so root-first is a
 * convention for readability — matching `GthAgentRunner.approvalRuleLists`, where the declared
 * entries precede the runtime grants — and never a precedence.
 *
 * Defaults are applied HERE, at the read site, rather than in `DEFAULT_CONFIG` — so the
 * effective-config snapshot the `/config` panel renders never churns (à la GS2-34
 * `injectModelContext` / GS2-63 `output.header`).
 *
 * This is the per-command half. The cross-LAYER half (a project config's lists adding to a global
 * config's rather than replacing them) is the additive-array policy in `config/loader.ts`; both are
 * needed, since either alone still loses a list silently.
 *
 * @param command The active command; selects the per-command block.
 */
export function resolveApprovals(
  config: Pick<GthConfig, 'commands' | 'approvals'> | undefined,
  command: GthCommand | undefined
): ResolvedApprovals {
  const root = toApprovalsObject(config?.approvals);
  const perCommand = toApprovalsObject(
    command
      ? (config?.commands as Record<string, { approvals?: ApprovalsConfig }> | undefined)?.[command]
          ?.approvals
      : undefined
  );

  return {
    rung: perCommand?.mode ?? root?.mode ?? DEFAULT_APPROVAL_RUNG,
    rater: perCommand?.rater ?? root?.rater,
    // `??`, so an EXPLICIT empty list is honoured: `allow: []` on a command states "nothing is
    // pre-trusted here" and must not read as "said nothing, inherit the root's".
    allow: perCommand?.allow ?? root?.allow ?? [],
    deny: [...(root?.deny ?? []), ...(perCommand?.deny ?? [])],
    escalate: [...(root?.escalate ?? []), ...(perCommand?.escalate ?? [])],
    raterTimeoutMs: perCommand?.raterTimeoutMs ?? root?.raterTimeoutMs,
    // `??`, so an EXPLICIT empty block is honoured exactly as an explicit empty `allow` is: it
    // states "believe nothing external here" and must not read as "said nothing, inherit the root".
    mcp: perCommand?.mcp ?? root?.mcp,
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
 *
 * **This decides the SHELL's gating only, and it is not the whole gated set.** With the shell tool
 * disabled — or on a non-dev-tools command (chat/api/…) — nothing about the shell is gated and
 * nothing is announced, but at `read-only` and `write` {@link resolveGatedToolNames} still gates
 * every bound tool the rung does not auto-grant, so an MCP call in a plain `chat` session is
 * escalated there. Read `gateShell` as "does the shell need the interrupt", never as "is the
 * interrupt needed at all".
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
