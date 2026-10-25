import { beforeEach, describe, expect, it, vi } from 'vitest';

// REL-28: execAsync must return stdout past Node's 1 MiB exec default whole. This runs a real
// child through the real shell (cmd.exe on Windows), so the command string is kept portable:
// the node path is double-quoted, and the -e script is double-quoted with only single quotes
// inside and no cmd.exe metacharacters. Nothing is written to stderr, which execAsync rejects on.
describe('execAsync large output', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns more than 1 MiB of stdout whole', async () => {
    const { execAsync } = await import('#src/utils/systemUtils.js');
    const size = 2 * 1024 * 1024;
    const command = `"${process.execPath}" -e "process.stdout.write('x'.repeat(${size}))"`;

    const result = await execAsync(command);

    expect(result.length).toBe(size);
  }, 30_000);
});
