/**
 * EXT-114 — the ACP entry points are STUBS, and a stub is a promise only if something checks it.
 *
 * Two properties, and the first is the one a unit test would miss: the `gaunt-sloth-acp` bin must
 * still RESOLVE. It is declared in `@gaunt-sloth/agent`'s `bin` map, so anyone who wired the
 * command into an editor has it on PATH; deleting the file turns a retired feature into a missing
 * executable, which the host reports as a broken install. So these cells spawn the real bin rather
 * than importing a function — importing proves the message exists, spawning proves the door does.
 *
 * The second is the contract with the host: a non-zero exit, and the explanation on stderr. An ACP
 * host treats stdout as the JSON-RPC framing channel, so prose written there is a protocol error,
 * not a message anyone reads; stdout must stay empty.
 *
 * Both doors are covered — the standalone bin and `gaunt-sloth --acp-agent` — because a stub kept
 * by only one of them is not a stub, it is a difference in behaviour between two spellings of the
 * same command.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACP_STUB_MESSAGE } from '#src/core/acpStub.js';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.resolve(agentDir, '..', 'app');

/** A sentence from the message, long enough that a truncated or reworded stub would not match. */
const MESSAGE_EXCERPT = 'ACP (Agent Client Protocol) server is not available';

describe('the ACP stub entry points (EXT-114)', () => {
  it('names EXT-46 as the rebuild, so the message points somewhere', () => {
    expect(ACP_STUB_MESSAGE).toContain('EXT-46');
    expect(ACP_STUB_MESSAGE).toContain(MESSAGE_EXCERPT);
  });

  it('gaunt-sloth-acp resolves, exits non-zero and explains on stderr', () => {
    const result = spawnSync('node', [path.join(agentDir, 'cli-acp.js')], {
      encoding: 'utf8',
      timeout: 60000,
    });

    // Resolution first: a missing bin or an unresolvable import would be a non-zero exit too, so
    // the message is what distinguishes "stubbed on purpose" from "broken".
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain(ACP_STUB_MESSAGE);
    expect(result.status).not.toBe(0);
    // stdout is the ACP protocol channel. Anything at all here corrupts framing.
    expect(result.stdout).toBe('');
  });

  it('gaunt-sloth --acp-agent does the same, rather than falling through to the CLI', () => {
    // The switch must be RECOGNISED: falling through would answer an ACP host with an interactive
    // session on stdout and hang it, which is worse than the missing bin this stub exists to avoid.
    const result = spawnSync('node', [path.join(appDir, 'cli.js'), '--acp-agent'], {
      encoding: 'utf8',
      timeout: 60000,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain(ACP_STUB_MESSAGE);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
