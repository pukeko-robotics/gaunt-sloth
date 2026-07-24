import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// OPS-24 — pure file-lock mechanics, no ollama required. Drives timing via injected tiny
// waitMs/staleMs (never real minutes), so the whole suite runs sub-second and deterministic.
// The helper is plain ESM (`it.js` is run by bare node); import it by relative path.
import { createOllamaLock, defaultLockPath } from '../integration-tests/support/ollamaLock.mjs';

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
    // Pre-write a fresh holder (a live run holding the GPU).
    const held = { pid: 99999, at: Date.now() };
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

  it('steals a STALE lock (crashed holder) and takes ownership with our pid', async () => {
    // Pre-write an old holder — 10 min ago, well past the tiny staleMs below.
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: Date.now() - 10 * 60_000 }));

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
