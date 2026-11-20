import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getExecSystemPrompt } from '#src/commands/commandIntrospection.js';
import { getStringFromStdin, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';
import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/core/utils/fileUtils.js';
import type { ConversationRef } from '@gaunt-sloth/core/history/conversationRef.js';
import type { SingleShotResume } from '@gaunt-sloth/core/runtime/singleShot.js';
import { resumeOption } from '#src/commands/resumeOption.js';
import { isAnthropicChatModel } from '@gaunt-sloth/core/providers/anthropicSampling.js';

export interface ExecCommandOptions {
  file?: string[];
  /**
   * Inline prompt text. When supplied, this is used as the prompt-executable directly instead of
   * reading the `[script]` file path. Mutually exclusive with the positional `[script]` (passing
   * both is an error — keeps the path-vs-text intent unambiguous).
   */
  message?: string;
  /** Override the LLM sampling temperature for this run (determinism knob). */
  temperature?: number;
  /**
   * Extra filesystem roots to allow for this run, in addition to the cwd sandbox (repeatable).
   * Opt-in widening of `exec`'s default cwd-only sandbox; LOUD because it removes a guardrail.
   */
  allowDir?: string[];
}

/**
 * Build the effective, non-interactive config for an `exec` run.
 *
 * `exec` is the prompt-as-script sibling of `ask`: it shares the same single-shot agent runtime
 * but tunes the config for reproducible, pipe-friendly "do-the-job" runs:
 * - the result is streamed to stdout and is NOT written to a md report by default (so it pipes
 *   cleanly), unless the user explicitly asks for a file via `-w`;
 * - inference cannot be interrupted with ESC (there is no interactive user);
 * - if a temperature is supplied it is applied to the LLM for near-deterministic output.
 *
 * `-w/--write-output-to-file` is a PROGRAM-level option, so commander puts it on the program and
 * never on this subcommand's own `options` — it reaches a command as
 * `commandLineConfigOverrides.writeOutputToFile`, which is why it is a parameter here rather than
 * a field of `ExecCommandOptions`. That override object is also the only thing that can tell
 * an explicit `-w` apart from a project config's `writeOutputToFile`: the merged `config` carries
 * both, and exec must keep piping cleanly under a config that turns reports on generally, so a
 * config-level value stays off and only the flag switches it on.
 *
 * Exposed (and unit-tested) separately so the runtime is reusable across the Pukeko impls.
 */
export function buildExecConfig(
  config: GthConfig,
  options: ExecCommandOptions,
  commandLineConfigOverrides: CommandLineConfigOverrides
): GthConfig {
  const execConfig: GthConfig = {
    ...config,
    // Non-interactive: ESC-to-interrupt only makes sense in a TTY session.
    canInterruptInferenceWithEsc: false,
    // Default to stdout-only so the run output can be piped; honor an explicit -w.
    writeOutputToFile: commandLineConfigOverrides.writeOutputToFile ?? false,
    // Opt-in sandbox widening: extra allowed roots beyond cwd for this run only.
    ...(options.allowDir && options.allowDir.length > 0 ? { allowDirs: options.allowDir } : {}),
  };

  // Best-effort determinism knob. LangChain chat models expose `temperature` as a mutable field;
  // setting it to 0 (the recommended exec default) makes runs as reproducible as the provider
  // allows. Guard with `in` so providers without the field are left untouched.
  //
  // Anthropic is the exception: its API rejects any `temperature` with a 400, even the default, and
  // a ChatAnthropic declares the field even when unset, so the `in` guard alone would write it onto
  // the request. The anthropic provider drops configured values for the same reason; see
  // `anthropicSampling.ts` in core.
  if (options.temperature !== undefined && isAnthropicChatModel(execConfig.llm)) {
    const model = (execConfig.llm as unknown as { model?: string }).model ?? 'unknown';
    displayWarning(
      `Anthropic no longer accepts a sampling temperature on any model; ` +
        `ignoring -t ${options.temperature} for model "${model}". ` +
        'The model samples at its own default; run without -t to silence this warning.'
    );
  } else if (
    options.temperature !== undefined &&
    execConfig.llm &&
    'temperature' in execConfig.llm
  ) {
    (execConfig.llm as unknown as { temperature: number }).temperature = options.temperature;
  }

  return execConfig;
}

/**
 * Adds the `exec` command to the program.
 *
 * `gth exec <script.md>` runs a markdown "prompt-executable" (prose + code/command snippets)
 * reliably and near-deterministically — "AI as a normal terminal technology". The script can be
 * a path argument, piped on stdin, or supplied via `-f`; extra `-f` files are prepended as
 * context. Output goes to stdout (suitable for piping); a non-zero exit code signals failure.
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function execCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('exec')
    .description(
      'Run a markdown prompt-executable (prose + code snippets) reliably and near-deterministically'
    )
    .argument('[script]', 'Path to the .md script to execute')
    .option(
      '-m, --message <text>',
      'Inline prompt text to execute (instead of a script file path). Cannot be combined with [script].'
    )
    .option(
      '-f, --file [files...]',
      'Additional context files. Their content is added BEFORE the script.'
    )
    .option(
      '-t, --temperature <number>',
      'LLM sampling temperature for this run (0 = most deterministic). Anthropic models ignore it with a warning.',
      parseFloat
    )
    .option(
      '--allow-dir <path>',
      'HAS NO EFFECT in this release (repeatable). It widened filesystem access beyond cwd for ' +
        'the removed deepagents backend; the flag still parses and warns, and the agent reads ' +
        'and writes within the working directory only.',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth exec scripts/release-notes.md\n' +
        '  $ gth exec -m "Summarize CHANGELOG.md in three bullets" -t 0\n' +
        '  $ cat scripts/lint-summary.md | gth exec\n' +
        '  $ gth exec scripts/build-fix.md -f error.log package.json\n' +
        '  $ gth exec scripts/release-notes.md -w RELEASE_NOTES.md\n' +
        '  $ gth exec --resume 42 -m "now do the same for the tests"\n'
    )
    .addOption(resumeOption())
    .action(
      async (
        script: string | undefined,
        options: ExecCommandOptions & { resume?: ConversationRef }
      ) => {
        // GS2-106 — `--resume` on `exec` itself, or the root `gth --resume <id> exec …`.
        const ref =
          options.resume ?? (program.getOptionValue('resume') as ConversationRef | undefined);
        await runExecCommand(
          script,
          options,
          commandLineConfigOverrides,
          ref === undefined ? undefined : { ref, surface: 'exec' }
        );
      }
    );
}

/**
 * GS2-106 — the input refusal for `exec --resume`, or `null` when the input is acceptable.
 *
 * A resumed `exec` takes its new input from `-m` and nothing else. What `exec` should do when its
 * FILE input is the same as the original run's is undecided on the node, so a script path, `-f`
 * and a script piped on stdin are all refused rather than guessed at. With `-m` given, stdin is
 * ignored exactly as a plain `exec -m` ignores it, so it is refused only where it would have been
 * the script.
 */
function execResumeInputRefusal(
  script: string | undefined,
  options: ExecCommandOptions
): string | null {
  const why = (what: string) =>
    `\`gth exec --resume\` takes its new input only from -m; ${what} cannot be given with it. ` +
    'Nothing was run.';
  if (script) return why('a script path');
  if (options.file && options.file.length > 0) return why('-f files');
  if (options.message === undefined && getStringFromStdin()) return why('a script piped on stdin');
  if (options.message === undefined) {
    return (
      '`gth exec --resume` needs the new message as -m, for example ' +
      '`gth exec --resume <id> -m "…"`. Nothing was run.'
    );
  }
  return null;
}

/**
 * The body of `gth exec`, shared with `gth history resume` for a conversation recorded by `exec`
 * (GS2-106), so both spellings run exactly one implementation.
 *
 * `resume`, when given, continues that conversation with `-m` as the new user message; see
 * `execResumeInputRefusal` for the input it refuses. The seam resolves and checks the
 * conversation first, and a refusal ends the command with exit status 1 and nothing run.
 */
export async function runExecCommand(
  script: string | undefined,
  options: ExecCommandOptions,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  resume?: { ref: ConversationRef | number; surface: 'exec' | 'history' }
): Promise<void> {
  // -m and a positional script path are mutually exclusive: keep path-vs-text unambiguous.
  if (script && options.message !== undefined) {
    throw new Error('Pass either a [script] path or -m/--message inline text, not both.');
  }

  if (resume) {
    // Refused before any config is loaded: the input is wrong whatever the conversation is.
    const refusal = execResumeInputRefusal(script, options);
    if (refusal) {
      displayError(refusal);
      setExitCode(1);
      return;
    }
  }

  const config = await initConfig(commandLineConfigOverrides);

  const content: string[] = [];

  // Extra context files are prepended (same convention as `ask`).
  if (options.file) {
    const fileContent = readMultipleFilesFromProjectDir(options.file);
    if (fileContent) {
      content.push(fileContent);
    }
  }

  // The script itself, in precedence order:
  //   1. -m/--message inline text (explicit; wins over stdin)
  //   2. a [script] file path argument
  //   3. stdin (pipe)
  const stringFromStdin = getStringFromStdin();
  if (options.message !== undefined) {
    content.push(wrapContent(options.message, 'script', 'prompt-executable script', true));
  } else if (script) {
    const scriptContent = readMultipleFilesFromProjectDir([script]);
    content.push(wrapContent(scriptContent, 'script', 'prompt-executable script', true));
  } else if (stringFromStdin) {
    content.push(wrapContent(stringFromStdin, 'script', 'prompt-executable script', true));
  }

  if (content.length === 0) {
    throw new Error(
      'A script is required: pass a .md path, inline text with -m, pipe it on stdin, or supply it with -f'
    );
  }

  if (options.allowDir && options.allowDir.length > 0) {
    displayWarning(
      `--allow-dir has no effect in this release: ${options.allowDir.join(', ')} stays ` +
        'outside the sandbox. The agent reads and writes within the working directory only.'
    );
  }

  const execConfig = buildExecConfig(config, options, commandLineConfigOverrides);

  let target: SingleShotResume | undefined;
  if (resume) {
    const { resolveSingleShotResume } = await import('#src/commands/singleShotResume.js');
    const resolved = await resolveSingleShotResume(execConfig, resume.ref, resume.surface);
    if (!resolved) {
      // Refused by the seam, which has said why. Nothing ran.
      setExitCode(1);
      return;
    }
    target = resolved;
  }

  const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
  const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
  const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

  let ok = false;
  try {
    ({ ok } = await runSingleShot(
      'EXEC',
      getExecSystemPrompt(execConfig),
      content.join('\n'),
      execConfig,
      createResolvers(),
      'exec',
      // exec asks for the lean backend, the only one shipped; config.agent.backend names no other.
      resolveAgentFactory(execConfig, 'lean'),
      // [[EXT-158]] — the same reading as `ask`: a person is watching this verb. The notice
      // goes to stderr, so a script piping `exec`'s stdout sees byte-for-byte what it did.
      //
      // [[EXT-178]] — and eligible for the end-of-run recap, which shares that property: it is
      // rendered on stderr and the answer on stdout is untouched. Whether one is produced is
      // the user's `recap` rung, `off` by default.
      {
        announceOutstandingWork: true,
        announceRunRecap: true,
        announceResumeHint: true,
        ...(target ? { resume: target } : {}),
      }
    ));
  } catch (error) {
    displayError(error instanceof Error ? error.message : String(error));
    ok = false;
  }

  if (!ok) {
    setExitCode(1);
  }
}
