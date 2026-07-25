import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// OPS-24 — pure file-lock mechanics, no ollama required. Drives timing via injected tiny
// waitMs/staleMs (never real minutes), so the whole suite runs sub-second and deterministic.
// The helper is plain ESM (`it.js` is run by bare node); import it by relative path.
import {
  createOllamaLock,
  defaultLockPath,
  isHolderAlive,
} from '../integration-tests/support/ollamaLock.mjs';

// A real, verifiably-dead pid: spawn a trivial child and wait for it to exit. Needed because an
// arbitrary large number (e.g. 99999) might collide with a real live process on the CI host —
// the OPS-25 tests specifically need a pid that is guaranteed reaped before use.
async function spawnAndReap(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return pid;
}

describe('ollamaLock', () => {
  let lockPath: string;

  beforeEach(() => {
    // Unique path per test so parallel/serial tests never collide on a shared file.
    lockPath = join(tmpdir(), `gth-it-ollama-test-${randomUUID()}.lock`);
  });

  afterEach(() => {
    rmSync(lockPath, { force: true });
  });

  it('acquires (lockfile exists with our pid), releases (lockfile gone), and release is idempotent', async () => {
    const lock = createOllamaLock({ lockPath });
    const release = await lock.acquire();

    // Acquired: the lockfile exists and records THIS process.
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(typeof info.at).toBe('number');

    // Released: the lockfile is gone.
    release();
    expect(existsSync(lockPath)).toBe(false);

    // Idempotent: a second release is a no-op and must not throw (even though the file is gone).
    expect(() => release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('throws loud when a FRESH lock is held, and does not delete the existing lock', async () => {
    // Pre-write a fresh holder (a live run holding the GPU). The pid must be a process that is
    // genuinely running — OPS-25 reclaims a lock whose holder is provably gone, so a made-up pid
    // would be stolen here and this test would assert nothing. Our own pid is the live one we can
    // always name.
    const held = { pid: process.pid, at: Date.now() };
    writeFileSync(lockPath, JSON.stringify(held));

    const log = vi.fn();
    const lock = createOllamaLock({
      lockPath,
      waitMs: 150, // tiny: give up almost immediately
      staleMs: 30 * 60_000, // large: the fresh holder is NOT stale, so never stolen
      log,
    });

    await expect(lock.acquire()).rejects.toThrow(/still held after \d+s/);

    // The live holder's lock must survive untouched — a waiter never deletes a fresh lock.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(held);

    // And it announced the wait loudly at least once (loud periodic "still waiting" notice).
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain('waiting for ollama GPU lock');
  });

  it('steals a lock past staleMs even though its holder is still ALIVE (time-based backstop)', async () => {
    // A LIVE pid with an ancient timestamp isolates the time-based path: the OPS-25 liveness probe
    // says "alive", so only staleMs can justify the steal. (Using a dead pid here would pass via
    // the liveness path and leave staleMs untested.)
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }));

    const lock = createOllamaLock({
      lockPath,
      waitMs: 30 * 60_000,
      staleMs: 1000, // tiny: the 10-min-old holder is clearly stale → steal it
    });

    const release = await lock.acquire();

    // Ownership transferred: the lockfile now carries OUR pid.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);

    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  // OPS-25 — the case that wedged a real run: a runner SIGTERMed mid-run leaves a FRESH lockfile
  // behind. Time-based staleness alone blocks every later run for the full 30 min.
  it('reclaims immediately when the holder is DEAD, however fresh the lock', async () => {
    const deadPid = await spawnAndReap();
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, at: Date.now() }));

    const log = vi.fn();
    const lock = createOllamaLock({
      lockPath,
      waitMs: 150, // tiny: if it waited on staleMs instead of reclaiming, this would throw
      staleMs: 30 * 60_000, // large: the lock is FRESH, so only the liveness probe can reclaim it
      log,
    });

    const release = await lock.acquire();

    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    expect(String(log.mock.calls.map((c) => c[0]).join('\n'))).toContain(
      `reclaiming ollama GPU lock from dead pid ${deadPid}`
    );

    release();
  });

  describe('isHolderAlive', () => {
    it('reports a running process alive', () => {
      expect(isHolderAlive(process.pid)).toBe(true);
    });

    it('reports an exited process dead', async () => {
      expect(isHolderAlive(await spawnAndReap())).toBe(false);
    });

    // Everything uncertain must answer "alive" so the lock is never stolen on a guess; staleMs
    // remains the backstop for those cases.
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a non-integer', 1.5],
      ['a string', '1234'],
      ['zero', 0],
      ['negative', -1],
      ['NaN', NaN],
    ])('treats %s as alive (conservative)', (_label, pid) => {
      expect(isHolderAlive(pid as number)).toBe(true);
    });
  });

  describe('defaultLockPath', () => {
    it('is distinct per host, stable for the same host, and sits under os.tmpdir()', () => {
      const a = defaultLockPath('http://127.0.0.1:11434');
      const b = defaultLockPath('http://10.0.0.5:11434');

      // Different daemons → different locks (they don't block each other).
      expect(a).not.toBe(b);
      // Same host → same lock (everything hitting one daemon serializes).
      expect(defaultLockPath('http://127.0.0.1:11434')).toBe(a);
      // Lives in the temp dir.
      expect(a.startsWith(tmpdir())).toBe(true);
      expect(a).toMatch(/gth-it-ollama-[0-9a-f]{12}\.lock$/);
    });
  });
});
