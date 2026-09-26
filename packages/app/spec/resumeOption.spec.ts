/**
 * GS2-106 — `--resume <id>` parses through the shared conversation-id parser: either id form is
 * accepted as a typed reference, and anything else is refused by commander before any config is
 * loaded, with the token named. Resolving the reference to a row happens later, in the resume seam;
 * that half is asserted in the agent package's `interactiveSessionModule.resume` spec.
 *
 * Parsed through a real commander program, because commander is what names the token in the
 * refusal: the parser's own message does not repeat it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const parse = async (value: string): Promise<{ resume?: unknown; error?: string }> => {
  const { resumeOption } = await import('#src/commands/resumeOption.js');
  let error = '';
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => (error += s), writeOut: () => {} });
  program.addOption(resumeOption());
  try {
    program.parse(['node', 'gth', '--resume', value]);
  } catch {
    return { error };
  }
  return { resume: program.opts().resume };
};

describe('--resume <id> — the shared parser (GS2-106)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses an integer id to an integer reference', async () => {
    expect(await parse('12')).toEqual({ resume: { kind: 'id', id: 12 } });
    expect(await parse('#12')).toEqual({ resume: { kind: 'id', id: 12 } });
  });

  it('parses a run id to a run reference, normalised to lower case', async () => {
    expect(await parse('0F8FAD5B-D9CB-469F-A165-70867728950E')).toEqual({
      resume: { kind: 'run', runId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
    });
  });

  it('refuses 12abc, naming the token, rather than reading it as 12', async () => {
    const { resume, error } = await parse('12abc');
    expect(resume).toBeUndefined();
    expect(error).toContain("'12abc'");
    expect(error).toContain('a positive whole number or a run id');
  });

  it('refuses a token that is only nearly a run id, naming it', async () => {
    const almost = '0f8fad5b-d9cb-469f-a165-70867728950';
    const { resume, error } = await parse(almost);
    expect(resume).toBeUndefined();
    expect(error).toContain(`'${almost}'`);
  });
});
