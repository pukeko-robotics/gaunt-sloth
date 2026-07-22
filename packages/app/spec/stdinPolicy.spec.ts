import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, Option } from 'commander';

/**
 * BATCH-11 (#405 gotcha #5) — the STDIN-skip policy for `eval`/`batch`.
 *
 * These specs drive `resolveInvokedCommandName` with the *real* operands commander produces (global
 * options with values, subcommand flags, positional args named like commands), mirroring exactly
 * how `cli.ts` calls it — so a green test here means the CLI wiring resolves the invoked command
 * correctly, without importing the CLI entry point (which runs on import).
 */

// A program shaped like cli.ts's top-level program: the same global options (some value-taking) plus
// the eval/batch subcommands with their own args/flags, so parseOptions has to disambiguate them.
function buildProgram(): Command {
  const program = new Command();
  program
    .name('gth')
    .option('-c, --config <path>', 'Path to custom configuration file')
    .option('-i, --identity-profile <identity>', 'Identity profile')
    .option('--verbose')
    .addOption(new Option('--nopipe').hideHelp(true))
    .addOption(new Option('--no-pipe').hideHelp(true));
  for (const name of ['eval', 'batch', 'ask', 'review', 'pr', 'chat']) {
    const command = program.command(name);
    if (name === 'eval' || name === 'batch') {
      command.argument('<x>').option('-j, --concurrency <n>').option('-o, --output <dir>');
    }
  }
  return program;
}

async function resolveFor(userArgs: string[]): Promise<string | undefined> {
  const { resolveInvokedCommandName } = await import('#src/utils/stdinPolicy.js');
  const program = buildProgram();
  // process.argv shape: [node, script, ...userArgs] — the real input cli.ts passes.
  const argv = ['node', 'gsloth', ...userArgs];
  return resolveInvokedCommandName(
    program.commands.map((command) => command.name()),
    program.parseOptions(argv).operands
  );
}

describe('stdinPolicy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('resolveInvokedCommandName (via real commander operands)', () => {
    it('resolves a plain eval invocation', async () => {
      expect(await resolveFor(['eval', 'suite.yaml'])).toBe('eval');
    });

    it('resolves batch too', async () => {
      expect(await resolveFor(['batch', 'script.md', '--over', 'x.csv', '--models', 'a,b'])).toBe(
        'batch'
      );
    });

    it('is not fooled by a global option value that precedes the command', async () => {
      // `-c ./my.config` — the value must not be mistaken for the command name.
      expect(await resolveFor(['-c', './my.config', 'eval', 'suite.yaml'])).toBe('eval');
    });

    it('is not fooled by subcommand flags after the command', async () => {
      expect(await resolveFor(['eval', '-j', '8', 'suite.yaml'])).toBe('eval');
    });

    it('resolves the real command, not a positional argument that happens to be named like one', async () => {
      // `gth eval eval` — the suite file is literally named `eval`; the subcommand still wins.
      expect(await resolveFor(['eval', 'eval'])).toBe('eval');
      // `gth review eval.diff` — a file arg on a stdin-reading command must resolve to review.
      expect(await resolveFor(['review', 'eval.diff'])).toBe('review');
    });

    it('resolves stdin-reading commands to themselves', async () => {
      expect(await resolveFor(['ask', 'what is this'])).toBe('ask');
      expect(await resolveFor(['pr', '123'])).toBe('pr');
    });

    it('returns undefined when no subcommand is given (default-command / bare gth)', async () => {
      expect(await resolveFor([])).toBeUndefined();
      expect(await resolveFor(['--verbose'])).toBeUndefined();
    });
  });

  describe('commandSkipsStdin', () => {
    it('skips stdin for eval and batch', async () => {
      const { commandSkipsStdin } = await import('#src/utils/stdinPolicy.js');
      expect(commandSkipsStdin('eval')).toBe(true);
      expect(commandSkipsStdin('batch')).toBe(true);
    });

    it('does NOT skip stdin for commands that consume a piped diff', async () => {
      const { commandSkipsStdin } = await import('#src/utils/stdinPolicy.js');
      expect(commandSkipsStdin('ask')).toBe(false);
      expect(commandSkipsStdin('review')).toBe(false);
      expect(commandSkipsStdin('pr')).toBe(false);
    });

    it('does NOT skip stdin when no command was resolved', async () => {
      const { commandSkipsStdin } = await import('#src/utils/stdinPolicy.js');
      expect(commandSkipsStdin(undefined)).toBe(false);
    });
  });

  describe('end-to-end policy (resolve + skip decision, as cli.ts composes them)', () => {
    it('eval/batch invocations decide to skip the stdin wait; ask/review do not', async () => {
      const { commandSkipsStdin } = await import('#src/utils/stdinPolicy.js');
      expect(commandSkipsStdin(await resolveFor(['eval', 'suite.yaml']))).toBe(true);
      expect(commandSkipsStdin(await resolveFor(['batch', 'script.md']))).toBe(true);
      expect(commandSkipsStdin(await resolveFor(['review', 'eval.diff']))).toBe(false);
      expect(commandSkipsStdin(await resolveFor(['ask', 'question']))).toBe(false);
      expect(commandSkipsStdin(await resolveFor([]))).toBe(false);
    });
  });
});
