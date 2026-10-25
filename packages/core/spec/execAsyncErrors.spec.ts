import { beforeEach, describe, expect, it, vi } from 'vitest';

// REL-28: how execAsync maps exec's outcomes. Pushing a real child past the 32 MiB cap would mean
// writing 32 MiB in a unit test, so exec is replaced here and called back with the error Node
// produces on overflow: an Error whose code is ERR_CHILD_PROCESS_STDIO_MAXBUFFER, carrying the
// message "stdout maxBuffer length exceeded" (probed on Node 24). The real-child cell is in
// execAsyncLargeOutput.spec.ts.

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const childProcessMock = {
  exec: vi.fn(),
};
vi.mock('node:child_process', () => childProcessMock);

function execCallsBack(error: Error | null, stdout: string, stderr: string): void {
  childProcessMock.exec.mockImplementation(
    (_command: string, _options: unknown, callback: ExecCallback) => {
      callback(error, stdout, stderr);
    }
  );
}

describe('execAsync error mapping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes the shared cap to exec as maxBuffer', async () => {
    const { execAsync } = await import('#src/utils/systemUtils.js');
    const { MAX_SUBPROCESS_BUFFER } = await import('#src/constants.js');
    execCallsBack(null, ' out \n', '');

    await expect(execAsync('some command')).resolves.toBe('out');

    expect(childProcessMock.exec).toHaveBeenCalledWith(
      'some command',
      { maxBuffer: MAX_SUBPROCESS_BUFFER },
      expect.any(Function)
    );
    expect(MAX_SUBPROCESS_BUFFER).toBe(32 * 1024 * 1024);
  });

  it('names the size limit when the output overflows it', async () => {
    const { execAsync } = await import('#src/utils/systemUtils.js');
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    execCallsBack(overflow, 'partial output', '');

    const rejection = await execAsync('some command').catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('output exceeded the 32 MiB limit');
    expect((rejection as Error).cause).toBe(overflow);
  });

  it('rejects with any other error unchanged', async () => {
    const { execAsync } = await import('#src/utils/systemUtils.js');
    const failure = Object.assign(new Error('Command failed: some command'), { code: 1 });
    execCallsBack(failure, '', 'boom');

    await expect(execAsync('some command')).rejects.toBe(failure);
  });

  it('still rejects with the stderr text when the command succeeds but writes to stderr', async () => {
    const { execAsync } = await import('#src/utils/systemUtils.js');
    execCallsBack(null, 'out', 'a warning');

    const rejection = await execAsync('some command').catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('a warning');
  });
});
