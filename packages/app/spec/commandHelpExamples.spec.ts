import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchCommand } from '#src/commands/batchCommand.js';
import { workflowCommand } from '#src/commands/workflowCommand.js';
import { insightsCommand } from '#src/commands/insightsCommand.js';
import { historyCommand } from '#src/commands/historyCommand.js';
import { execCommand } from '#src/commands/execCommand.js';
import { configCommand } from '#src/commands/configCommand.js';

/**
 * OPS-21 — every command documented in docs/COMMANDS.md must also print a concrete, runnable
 * example in its own `--help` (DOC-STYLE rule 6: one source of truth — the same example lives in
 * COMMANDS.md and in `--help`). This asserts that for the six commands OPS-20 documented but
 * shipped docs-only (`batch`, `workflow`, `insights`, `history`, `exec`, `config`), mirroring the
 * `eval`/`ask`/`review` `.addHelpText('after', …)` pattern.
 *
 * `addHelpText('after', …)` is emitted at `outputHelp()` time (the `afterHelp` event), NOT by
 * `helpInformation()`, so the example block only appears when help is rendered the way a real
 * `--help` invocation renders it — capture that via `outputHelp()` + `configureOutput`.
 */
function renderHelp(cmd: Command): string {
  let out = '';
  cmd.configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (out += s) });
  cmd.outputHelp(); // NOT .help() — that would call process.exit
  return out;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const commandsDoc = fs.readFileSync(path.join(rootDir, 'docs', 'COMMANDS.md'), 'utf8');

interface HelpExampleCase {
  /** The subcommand name, as registered on the program. */
  name: string;
  /** Register the command onto a fresh program. */
  register: (_program: Command) => void;
  /**
   * A canonical example invocation from this command's COMMANDS.md `### Examples` section — the
   * bare `gsloth …` form, which is a substring of BOTH the `  $ gsloth …` help line and the docs
   * line, so a single string proves rule 6 in both places.
   */
  example: string;
}

const cases: HelpExampleCase[] = [
  {
    name: 'batch',
    register: (program) => batchCommand(program, {}),
    example: 'gsloth batch prompts/triage.md --over data/tickets.csv -j 8',
  },
  {
    name: 'workflow',
    register: (program) => workflowCommand(program, {}),
    example: 'gsloth workflow workflows/summarize-prs.mjs',
  },
  {
    name: 'insights',
    register: (program) => insightsCommand(program),
    example: 'gsloth insights --db ./project-history.db',
  },
  {
    name: 'history',
    register: (program) => historyCommand(program),
    example: 'gsloth history search vertexai timeout',
  },
  {
    name: 'exec',
    register: (program) => execCommand(program, {}),
    example: 'gsloth exec scripts/release-notes.md',
  },
  {
    name: 'config',
    register: (program) => configCommand(program, {}),
    example: 'gsloth config validate',
  },
];

describe('OPS-21 — documented commands print a runnable example in --help (DOC-STYLE rule 6)', () => {
  it.each(cases)(
    '`gth $name --help` prints its COMMANDS.md example',
    ({ name, register, example }) => {
      const program = new Command();
      register(program);
      const cmd = program.commands.find((c) => c.name() === name);
      if (!cmd) throw new Error(`command "${name}" was not registered on the program`);
      const help = renderHelp(cmd);
      expect(help).toContain('Examples:');
      expect(help, `${name} --help is missing its runnable example`).toContain(example);
    }
  );

  it.each(cases)(
    'the `$name` --help example is verbatim in COMMANDS.md (single source of truth)',
    ({ example }) => {
      expect(commandsDoc, `example not found verbatim in COMMANDS.md: ${example}`).toContain(
        example
      );
    }
  );
});
