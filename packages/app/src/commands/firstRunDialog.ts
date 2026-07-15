import { USER_PROJECT_CONFIG_JSON } from '@gaunt-sloth/core/constants.js';
import {
  buildInitConfigContent,
  detectProviders,
  discoverModelsWithProvenance,
  INTERACTIVE_MODEL_FETCH_TIMEOUT_MS,
  type DetectedProvider,
  type ModelDiscoveryResult,
  type ModelInfo,
  type ProviderId,
} from '@gaunt-sloth/core/providers/modelDiscovery.js';
import { getGlobalGslothConfigWritePath } from '@gaunt-sloth/core/utils/globalConfigUtils.js';
import {
  displayInfo,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  createInterface,
  env,
  stdin,
  stdout,
  type ReadLineInterface,
} from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  getGslothConfigWritePath,
  writeFileWithMessages,
} from '@gaunt-sloth/review/utils/fileUtils.js';
import { ensureGslothDir, writeProjectReviewPreamble } from '#src/commands/configSetup.js';
import { existsSync } from 'node:fs';
import { shouldUseTui } from '#src/tui/shouldUseTui.js';
import { isInkAvailable } from '#src/tui/loadInk.js';
import { SelectCancelledError } from '#src/tui/selectCancelled.js';

/**
 * Where the first-run dialog (CFG-2) persists the chosen provider/model config.
 * `project` writes into the project's `.gsloth/.gsloth-settings/` (CFG-3 loads it
 * as the highest-precedence layer); `global` writes into `~/.gsloth/`, the base
 * layer shared by every project.
 */
export type ConfigScope = 'project' | 'global';

type AskFn = (question: string) => Promise<string>;

/**
 * CFG-11 — picks one option from a labelled list. In an interactive TUI this is the Ink
 * arrow-key selector; in non-TTY runs it is the readline number menu. The dialog routes
 * provider / model / scope choices through this seam so the same flow drives both UIs and
 * stays unit-testable (tests inject a deterministic `select`).
 */
export type SelectFn = (title: string, options: string[], defaultIndex: number) => Promise<number>;

/**
 * Injectable side effects, so the dialog can be unit-tested without touching the
 * filesystem, the network (Ollama probe) or stdin. Defaults wire the real
 * CFG-1 detection + CFG-3 write paths.
 */
export interface FirstRunDialogDeps {
  detectProviders: typeof detectProviders;
  /**
   * CFG-21 — fetches the chosen provider's model list WITH its {@link ModelDiscoveryResult}
   * provenance, baking in the generous interactive timeout by default. Returns `{ models, status }`
   * so the dialog can surface an honest degrade notice when a live fetch was attempted and failed
   * (`status: 'fallback'`) rather than silently swapping in a by-design curated list (`'curated'`).
   */
  fetchModels: (providerId: ProviderId) => Promise<ModelDiscoveryResult>;
  /**
   * CFG-21 — runs `run` while a visible "working" indicator is shown (an Ink spinner on an
   * interactive TTY, a plain printed line otherwise), clearing it when `run` settles. The model
   * fetch is routed through this seam so the wait is never silent and a test can assert it fired.
   */
  withProgress: <T>(label: string, run: () => Promise<T>) => Promise<T>;
  ensureGslothDir: typeof ensureGslothDir;
  writeProjectReviewPreamble: typeof writeProjectReviewPreamble;
  /** Resolves the config file path for the chosen scope (does not write). */
  resolveConfigPath: (scope: ConfigScope) => string;
  /** True when a config file already exists at `path`. */
  configExists: (path: string) => boolean;
  /**
   * (Over)writes the config content at the scope's path and returns that path. The dialog only
   * calls this once it has decided to write, so this always writes (never a silent no-clobber skip).
   */
  writeConfig: (scope: ConfigScope, content: string) => string;
  /** Prompts the user and resolves with their (untrimmed) answer. */
  ask: AskFn;
  /** CFG-11 — list selection (Ink arrow-keys in a TUI, readline number menu otherwise). */
  select: SelectFn;
}

/**
 * Orders providers so usable ones (API key present / Ollama running) come first,
 * preserving the registry order within each group (Array.prototype.sort is stable).
 */
export function orderProviders(providers: DetectedProvider[]): DetectedProvider[] {
  return [...providers].sort((a, b) => Number(b.available) - Number(a.available));
}

/**
 * Parses a 1-based menu answer into a 0-based index, or null when it is not a
 * whole number within `1..count`.
 */
export function parseMenuSelection(answer: string, count: number): number | null {
  const n = Number.parseInt(answer.trim(), 10);
  if (Number.isNaN(n) || n < 1 || n > count) return null;
  return n - 1;
}

/** The index of the first ⭐ preferred model, or 0 when none are flagged. */
export function defaultModelIndex(models: ModelInfo[]): number {
  const preferred = models.findIndex((m) => m.preferred);
  return preferred >= 0 ? preferred : 0;
}

/**
 * Builds the `.gsloth.config.json` body for a chosen provider + model. Delegates to the shared
 * {@link buildInitConfigContent} so the interactive first-run path stamps the same `$schema`
 * pointer (GS2-1) as the per-provider template writers. Previously this local builder omitted
 * `$schema`, so a config created through the first-run dialog got no editor autocomplete/validation.
 * First-run always has an explicit model chosen, so it is written into the config (unlike a bare
 * `init <provider>` template, which omits the model to track the curated fallback, CFG-14).
 */
export function buildConfigContent(providerId: ProviderId, model: string): string {
  return `${buildInitConfigContent(providerId, model)}\n`;
}

/** Resolves the config write path for the chosen scope (CFG-3 layering). */
export function resolveConfigWritePath(scope: ConfigScope): string {
  return scope === 'global'
    ? getGlobalGslothConfigWritePath(USER_PROJECT_CONFIG_JSON)
    : getGslothConfigWritePath(USER_PROJECT_CONFIG_JSON);
}

/**
 * CFG-9 — an explicit, readable readiness label for a provider in the menu. The old bare
 * `✓`/blank mark read like a selection checkbox; this spells the state out instead.
 */
export function providerReadinessLabel(provider: DetectedProvider): string {
  if (provider.available) {
    return provider.apiKeyEnvironmentVariable ? 'API Key Available' : 'Ready';
  }
  return provider.requiresExternalAuth ? 'Needs External Auth' : 'No API Key';
}

/**
 * Short, human description of a provider's readiness for the menu line.
 */
function providerStatus(provider: DetectedProvider): string {
  if (provider.available) {
    return provider.apiKeyEnvironmentVariable
      ? `key: ${provider.apiKeyEnvironmentVariable}`
      : 'ready';
  }
  return provider.requiresExternalAuth ? 'needs external auth' : 'no API key set';
}

/**
 * Prompts until the answer is a valid 1-based selection. When `defaultIdx` is
 * provided, an empty answer resolves to it (so the menu can show a default).
 */
async function promptMenu(
  ask: AskFn,
  question: string,
  count: number,
  defaultIdx?: number
): Promise<number> {
  for (;;) {
    const answer = (await ask(question)).trim();
    if (answer === '' && defaultIdx !== undefined) return defaultIdx;
    const idx = parseMenuSelection(answer, count);
    if (idx !== null) return idx;
    displayWarning(`Please enter a number between 1 and ${count}.`);
  }
}

function defaultWriteConfig(scope: ConfigScope, content: string): string {
  const path = resolveConfigWritePath(scope);
  writeFileWithMessages(path, content);
  return path;
}

/**
 * CFG-11 — true when the current environment can drive the Ink arrow-key selector. Reuses the
 * same TUI-activation policy as the chat/code dispatcher ({@link shouldUseTui}) so behaviour
 * is consistent: a real interactive TTY with Ink installed and no opt-out.
 */
async function canUseInkSelect(): Promise<boolean> {
  if (
    !shouldUseTui({
      stdoutIsTTY: !!stdout.isTTY,
      stdinIsTTY: !!stdin.isTTY,
      noTuiFlag: false,
      tuiFlag: false,
      term: env.TERM,
      ci: !!env.CI,
      gthNoTui: !!env.GTH_NO_TUI,
      inkAvailable: true,
    })
  ) {
    return false;
  }
  return await isInkAvailable();
}

/**
 * Default {@link SelectFn}: the Ink keyboard selector when the environment supports it,
 * otherwise the readline number menu via {@link ask}. The Ink module is imported lazily so
 * a readline-only run never loads React/Ink.
 */
function makeDefaultSelect(ask: AskFn): SelectFn {
  return async (title, options, defaultIndex) => {
    if (await canUseInkSelect()) {
      const { runInkSelect } = await import('#src/tui/components/SelectList.js');
      return await runInkSelect(
        title,
        options.map((label) => ({ label })),
        defaultIndex
      );
    }
    // Readline fallback: render the numbered list, then prompt.
    displayInfo(title);
    options.forEach((label, index) => {
      const isDefault = index === defaultIndex ? ' (default)' : '';
      displayInfo(`  ${index + 1}. ${label}${isDefault}`);
    });
    return await promptMenu(ask, `\nChoice [${defaultIndex + 1}]: `, options.length, defaultIndex);
  };
}

/**
 * CFG-21 — the default {@link FirstRunDialogDeps.withProgress}: an Ink spinner while `run` is in
 * flight when the environment can drive interactive Ink (the same activation policy as
 * {@link makeDefaultSelect}), otherwise a plain printed line via {@link displayInfo} on the
 * readline / non-TTY path. Either way the wait is visible, never silent. The Ink module is
 * imported lazily so a readline-only run never loads React/Ink.
 */
export function makeDefaultProgress(): <T>(label: string, run: () => Promise<T>) => Promise<T> {
  return async (label, run) => {
    if (await canUseInkSelect()) {
      const { runWithInkProgress } = await import('#src/tui/components/FetchProgress.js');
      return runWithInkProgress(label, run);
    }
    displayInfo(label);
    return run();
  };
}

/**
 * CFG-2 — the first-run configuration dialog.
 *
 * Walks the user through: (1) picking a provider (usable ones first, detected via
 * CFG-1), (2) picking a model (⭐ preferred ones flagged, first preferred is the
 * default), and (3) choosing whether to store the config for this project or
 * globally (CFG-3). Writes a minimal `{ llm: { type, model } }` config and, for
 * the project scope, scaffolds the review/guidelines preamble.
 */
export async function runFirstRunDialog(
  overrides: Partial<FirstRunDialogDeps> = {},
  force = false
): Promise<void> {
  // The readline interface is created LAZILY, only when a readline prompt is actually needed
  // (the non-TTY number-menu fallback, or free-text model entry). On the Ink-select path it is
  // never created, so readline never binds stdin/raw-mode alongside Ink — two owners on the same
  // stdin is what corrupted the terminal handoff into the session's TUI.
  const rlHolder: { current: ReadLineInterface | null } = { current: null };
  const ask: AskFn =
    overrides.ask ??
    ((q) => {
      rlHolder.current ??= createInterface({ input: stdin, output: stdout });
      return rlHolder.current.question(q);
    });
  const deps: FirstRunDialogDeps = {
    detectProviders,
    fetchModels: (providerId) =>
      discoverModelsWithProvenance(providerId, { timeoutMs: INTERACTIVE_MODEL_FETCH_TIMEOUT_MS }),
    withProgress: makeDefaultProgress(),
    ensureGslothDir,
    writeProjectReviewPreamble,
    resolveConfigPath: resolveConfigWritePath,
    configExists: existsSync,
    writeConfig: defaultWriteConfig,
    ask,
    select: makeDefaultSelect(ask),
    ...overrides,
  };

  try {
    // 1. Provider.
    const providers = orderProviders(await deps.detectProviders());
    if (providers.length === 0) {
      displayWarning('No providers are known to Gaunt Sloth. Cannot configure.');
      return;
    }
    const providerOptions = providers.map(
      (p) => `${p.label} [${providerReadinessLabel(p)}] (${providerStatus(p)})`
    );
    const provider = providers[await deps.select('Select a provider:', providerOptions, 0)];

    if (!provider.available) {
      displayWarning(
        `${provider.label} is not ready yet — you will need to ${
          provider.requiresExternalAuth
            ? 'complete its external authentication'
            : 'set its API key environment variable'
        } before running gsloth. Writing the config so you can fill in the rest.`
      );
    }

    // 2. Model. The live fetch can take a moment for a large cloud catalog (OpenRouter ~300
    //    models), so show a visible indicator while it runs (CFG-21) instead of a silent pause,
    //    and fetch with the generous interactive timeout (baked into deps.fetchModels) so a big
    //    list is not lost to the short 2s probe race and silently replaced by a curated stub.
    const { models, status } = await deps.withProgress(
      `Fetching models from ${provider.label}…`,
      () => deps.fetchModels(provider.id)
    );
    let model: string;
    if (models.length === 0) {
      displayWarning(`No models discovered for ${provider.label}.`);
      model = (await deps.ask('Enter a model id to use: ')).trim();
      if (!model) {
        displayWarning('No model entered; aborting setup.');
        return;
      }
    } else {
      // CFG-21 — when a live fetch WAS attempted and fell back to the curated stub, say so, so a
      // short curated list is never mistaken for the provider's full catalog. Fires ONLY on
      // `status: 'fallback'` (attempted-and-failed) — never for a by-design `curated` list
      // (`kind:'none'` provider or no API key present), and never on the empty-list path above.
      if (status === 'fallback') {
        displayWarning(`Couldn't reach ${provider.label}; showing a short curated list.`);
      }
      const fallback = defaultModelIndex(models);
      const modelOptions = models.map((m) => `${m.preferred ? '⭐ ' : '   '}${m.id}`);
      model =
        models[await deps.select(`Select a model for ${provider.label}:`, modelOptions, fallback)]
          .id;
    }

    // 3. Scope.
    const scope: ConfigScope =
      (await deps.select(
        'Where should this configuration be stored?',
        ['This project only (.gsloth/.gsloth-settings/)', 'Globally for all projects (~/.gsloth/)'],
        0
      )) === 1
        ? 'global'
        : 'project';

    // 4. Overwrite guard. If a config already exists at the chosen scope's path and the user did
    //    not pass --force, ask whether to overwrite (default No). On No we keep the existing file
    //    and print an honest line — never the misleading "Configured / Config written" on a skip.
    const configPath = deps.resolveConfigPath(scope);
    if (deps.configExists(configPath) && !force) {
      const overwrite =
        (await deps.select(
          `A config already exists at ${configPath}. Overwrite it?`,
          ['No, keep the existing config', 'Yes, overwrite it'],
          0
        )) === 1;
      if (!overwrite) {
        displayInfo(`Kept existing config at ${configPath} (not modified).`);
        return;
      }
    }

    // 5. Scaffold (project only) + write.
    if (scope === 'project') {
      deps.ensureGslothDir();
      deps.writeProjectReviewPreamble();
    }
    const writtenPath = deps.writeConfig(scope, buildConfigContent(provider.id, model));

    displaySuccess(`Configured ${provider.label} / ${model} (${scope}).`);
    displayInfo(`Config written to ${writtenPath}`);
    if (provider.apiKeyEnvironmentVariable) {
      displayInfo(`Using API key from ${provider.apiKeyEnvironmentVariable}.`);
    } else if (!provider.available && !provider.requiresExternalAuth) {
      displayInfo('Remember to set your API key environment variable before running gsloth.');
    }
  } catch (e) {
    // CFG-20 — a Ctrl+C (any step) or an Esc on the first step aborts the whole dialog: unwind
    // out of whichever `select` was open and return WITHOUT writing a config and WITHOUT the false
    // "Configured … / Config written to …" success line (mirroring CFG-19's honest-skip contract).
    // The caller (startSession / initCommand) sees no config was written and does not launch a
    // session. Any non-abort error still propagates.
    if (e instanceof SelectCancelledError) {
      displayWarning('Setup cancelled. No configuration was written.');
      return;
    }
    throw e;
  } finally {
    rlHolder.current?.close();
  }
}
