/**
 * EXT-15 — unit coverage for the platform-specific timeout reap in
 * `killProcessGroup`. The Windows hang it fixes cannot be reproduced on a POSIX
 * CI host, so we stub `process.platform` and assert the branch chooses the right
 * kill mechanism: `taskkill /T (/F)` on win32, `process.kill(-pid)` elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: spawnSyncMock,
}));

describe('killProcessGroup platform branch', () => {
  let killProcessGroup: typeof import('#src/tools/GthDevToolkit.js').killProcessGroup;
  const realPlatform = process.platform;

  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    ({ killProcessGroup } = await import('#src/tools/GthDevToolkit.js'));
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('uses taskkill /T (no /F) for SIGTERM on win32', () => {
    setPlatform('win32');
    const kill = vi.fn();
    const procKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessGroup({ pid: 4321, kill }, 'SIGTERM');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T'],
      expect.objectContaining({ windowsHide: true })
    );
    // Never the POSIX group-kill, and no fallback child.kill on success.
    expect(procKill).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    procKill.mockRestore();
  });

  it('escalates to taskkill /F for SIGKILL on win32', () => {
    setPlatform('win32');
    killProcessGroup({ pid: 99, kill: vi.fn() }, 'SIGKILL');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '99', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('falls back to child.kill when taskkill itself throws on win32', () => {
    setPlatform('win32');
    spawnSyncMock.mockImplementation(() => {
      throw new Error('taskkill ENOENT');
    });
    const kill = vi.fn();

    killProcessGroup({ pid: 7, kill }, 'SIGTERM');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('signals the negative pid (process group) on POSIX', () => {
    setPlatform('linux');
    const procKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessGroup({ pid: 1234, kill: vi.fn() }, 'SIGTERM');

    expect(procKill).toHaveBeenCalledWith(-1234, 'SIGTERM');
    expect(spawnSyncMock).not.toHaveBeenCalled();
    procKill.mockRestore();
  });

  it('does nothing when there is no pid', () => {
    setPlatform('win32');
    const kill = vi.fn();
    killProcessGroup({ pid: undefined, kill }, 'SIGTERM');
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
