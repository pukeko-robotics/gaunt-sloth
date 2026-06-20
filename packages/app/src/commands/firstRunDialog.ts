import { USER_PROJECT_CONFIG_JSON } from '@gaunt-sloth/core/constants.js';
import {
  detectProviders,
  listModels,
  type DetectedProvider,
  type ModelInfo,
  type ProviderId,
} from '@gaunt-sloth/core/providers/modelDiscovery.js';
import { getGlobalGslothConfigWritePath } from '@gaunt-sloth/core/utils/globalConfigUtils.js';
import {
  displayInfo,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { createInterface, env, stdin, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import {
  getGslothConfigWritePath,
  writeFileIfNotExistsWithMessages,
} from '@gaunt-sloth/review/utils/fileUtils.js';
import { ensureGslothDir, writeProjectReviewPreamble } from '#src/commands/configSetup.js';
import { shouldUseTui } from '#src/tui/shouldUseTui.js';
import { isInkAvailable } from '#src/tui/loadInk.js';

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
  listModels: typeof listModels;
  ensureGslothDir: typeof ensureGslothDir;
  writeProjectReviewPreamble: typeof writeProjectReviewPreamble;
  /** Writes the config content to the scope's path and returns that path. */
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

/** Builds the `.gsloth.config.json` body for a chosen provider + model. */
export function buildConfigContent(providerId: ProviderId, model: string): string {
  return `${JSON.stringify({ llm: { type: providerId, model } }, null, 2)}\n`;
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
  writeFileIfNotExistsWithMessages(path, content);
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
 * CFG-2 — the first-run configuration dialog.
 *
 * Walks the user through: (1) picking a provider (usable ones first, detected via
 * CFG-1), (2) picking a model (⭐ preferred ones flagged, first preferred is the
 * default), and (3) choosing whether to store the config for this project or
 * globally (CFG-3). Writes a minimal `{ llm: { type, model } }` config and, for
 * the project scope, scaffolds the review/guidelines preamble.
 */
export async function runFirstRunDialog(
  overrides: Partial<FirstRunDialogDeps> = {}
): Promise<void> {
  const rl = overrides.ask ? null : createInterface({ input: stdin, output: stdout });
  const ask: AskFn = overrides.ask ?? ((q) => rl!.question(q));
  const deps: FirstRunDialogDeps = {
    detectProviders,
    listModels,
    ensureGslothDir,
    writeProjectReviewPreamble,
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

    // 2. Model.
    const models = await deps.listModels(provider.id);
    let model: string;
    if (models.length === 0) {
      displayWarning(`No models discovered for ${provider.label}.`);
      model = (await deps.ask('Enter a model id to use: ')).trim();
      if (!model) {
        displayWarning('No model entered; aborting setup.');
        return;
      }
    } else {
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

    // 4. Scaffold (project only) + write.
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
  } finally {
    rl?.close();
  }
}
