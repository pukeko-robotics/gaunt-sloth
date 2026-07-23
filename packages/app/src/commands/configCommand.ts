import { Command } from 'commander';
import {
  type CommandLineConfigOverrides,
  type GthConfig,
  createNamedProfile,
  initConfig,
  validateConfig,
} from '@gaunt-sloth/core/config.js';
import {
  display,
  displayError,
  displayInfo,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * Config keys whose VALUES must never be printed. Matched case-insensitively against the key
 * name at any depth, so an accidental inline secret (an API key pasted into `configuration`,
 * a bearer token, …) is redacted rather than echoed by `gth config print`.
 */
const SECRET_KEY_RE = /(api[-_]?key|secret|token|password|passwd|authorization|bearer|credential)/i;
const REDACTED = '***REDACTED***';

/**
 * Produce a plain, printable, secret-free view of a fully-resolved {@link GthConfig}.
 *
 * The resolved config carries live, non-serializable objects (the instantiated `llm`, tool
 * instances, middleware); those are replaced with short descriptors so the output is readable
 * and JSON-safe. Every value under a secret-looking key is redacted. Pure — returns a fresh
 * object and never mutates the input.
 */
export function redactConfigForPrint(config: GthConfig): Record<string, unknown> {
  // `llm` (the live BaseChatModel) is intentionally stripped and re-added below as a descriptor.
  const {
    llm: _llm,
    tools,
    middleware,
    ...rest
  } = config as GthConfig & {
    tools?: unknown[];
    middleware?: unknown[];
  };
  void _llm;

  // Deep-clone the JSON-safe remainder through a redacting replacer. Functions are dropped by
  // JSON.stringify (fine — a printed config is documentation, not an executable). A defensive
  // fallback keeps `print` working even if some exotic value is not serializable.
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(
      JSON.stringify(rest, (key, value) => (SECRET_KEY_RE.test(key) ? REDACTED : value))
    ) as Record<string, unknown>;
  } catch {
    out = {};
  }

  // Reinstate the stripped live fields as human descriptors (never the instances themselves).
  out.llm = config.modelDisplayName ? `[chat model: ${config.modelDisplayName}]` : '[chat model]';
  if (Array.isArray(tools)) out.tools = `[${tools.length} tool instance(s)]`;
  if (Array.isArray(middleware)) out.middleware = `[${middleware.length} middleware]`;
  return out;
}

/**
 * Adds the `config` command group (GS2-1 read-side):
 *
 * - `gth config print [--json]` — resolve the config exactly as a run would (up-tree discovery
 *   + global base + defaults merge) and print it, with secrets redacted. `--json` emits only the
 *   JSON object (machine-readable); the default adds a source header.
 * - `gth config validate` — validate the effective raw config against the schema WITHOUT building
 *   the LLM. Unknown keys warn; a schema violation prints a path-scoped message and exits non-zero.
 * - `gth config profile create <name>` (GS2-33) — scaffold a new named profile
 *   (`.gsloth/.gsloth-settings/<name>/.gsloth.config.json`) seeded from the current effective config
 *   (or a minimal template), schema-validated before it is written. Select it later with
 *   `--profile <name>` (or reuse it inside a subagent via the `subagents` config).
 *
 * `print` / `validate` honour the global `--config` / `--identity-profile` (`--profile`) overrides
 * via `commandLineConfigOverrides`.
 */
export function configCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  const config = program
    .command('config')
    .description('Inspect and validate the resolved Gaunt Sloth configuration')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gsloth config print\n' +
        "  $ gsloth config print --json | jq '.llm'\n" +
        '  $ gsloth config validate\n' +
        '  $ gsloth config profile create cheap --model gemini-2.0-flash-lite\n'
    );

  const profile = config
    .command('profile')
    .description('Create and manage named config profiles (.gsloth-settings/<name>/)');

  profile
    .command('create <name>')
    .description(
      'Scaffold a named profile seeded from the current config (or a template); ' +
        'select it later with --profile <name>'
    )
    .option('--model <id>', 'Set the profile model id (overrides the seeded/template model)')
    .option('--force', 'Overwrite an existing profile of the same name')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gsloth config profile create cheap --model gemini-2.0-flash-lite\n' +
        '  $ gsloth --profile cheap ask "summarise the open TODOs in this repo"\n'
    )
    .action(async (name: string, options: { model?: string; force?: boolean }) => {
      // Best-effort seed from the current effective config. A missing/invalid current config is not
      // fatal here — the scaffolder falls back to a valid template — so swallow the resolution error.
      let seed: GthConfig | undefined;
      try {
        seed = await initConfig(commandLineConfigOverrides);
      } catch {
        seed = undefined;
      }
      try {
        const { path, llm } = createNamedProfile(name, {
          seedType: seed?.modelProviderType,
          seedModel: seed?.modelDisplayName,
          modelOverride: options.model,
          force: options.force,
        });
        displaySuccess(`Created profile "${name}" at ${path}`);
        displayInfo(
          `It uses ${llm.type} / ${llm.model}. Edit that file, then run with --profile ${name}.`
        );
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        setExitCode(1);
      }
    });

  config
    .command('print')
    .description('Print the fully-resolved configuration (secrets redacted)')
    .option('--json', 'Emit only the JSON object (machine-readable), no header')
    .action(async (options: { json?: boolean }) => {
      try {
        const resolved = await initConfig(commandLineConfigOverrides);
        const printable = redactConfigForPrint(resolved);
        const json = JSON.stringify(printable, null, 2);
        if (options.json) {
          display(json);
        } else {
          displayInfo('Resolved Gaunt Sloth configuration (secrets redacted):');
          display(json);
        }
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        setExitCode(1);
      }
    });

  config
    .command('validate')
    .description('Validate the configuration against the schema; exits non-zero when invalid')
    .action(async () => {
      try {
        const report = await validateConfig(commandLineConfigOverrides);

        if (!report.found) {
          displayError(
            'No configuration file found to validate. Run `gth init` to create one, ' +
              'or pass --config <path>.'
          );
          setExitCode(1);
          return;
        }

        // GS2-29 — a run validates every layer (project + global), so the report carries a
        // per-layer verdict. Prefix each warning/error with its source label so the user knows
        // which file to fix.
        for (const layer of report.layers) {
          for (const warning of layer.warnings) {
            displayWarning(`${layer.sourceLabel}: ${warning}`);
          }
        }

        const invalidLayers = report.layers.filter((layer) => !layer.ok);
        if (invalidLayers.length === 0) {
          displaySuccess(
            `Configuration is valid: ${report.layers.map((layer) => layer.sourceLabel).join(', ')}`
          );
          return;
        }

        // Report EVERY failing layer, not just the first, so the user fixes all offending files.
        for (const layer of invalidLayers) {
          displayError(
            `Invalid configuration in ${layer.sourceLabel}:\n${layer.errorMessage ?? ''}`
          );
        }
        setExitCode(1);
      } catch (error) {
        // A JSONC/module parse failure lands here — surface it as an invalid-config error.
        displayError(
          `Failed to read configuration: ${error instanceof Error ? error.message : String(error)}`
        );
        setExitCode(1);
      }
    });
}
