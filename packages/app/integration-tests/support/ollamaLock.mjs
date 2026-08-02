// OPS-24 — machine-local mutual exclusion for ollama integration-test runs.
//
// The single local GPU is a shared, non-partitionable resource: one ~18 GB card holds one
// ollama model at a time. Two processes driving ollama at once (a rogue background agent racing
// a foreground run, or two `pnpm run it ollama …` invocations) thrash VRAM and time out in ways
// that *look like* model-capability failures — this cost hours during QA-8. Ports are allocated
// per-worktree (OPS-8); the GPU can't be partitioned, so it must be mutually excluded. This
// helper is a dependency-free, path-keyed file lock: `it.js` acquires it before driving ollama
// and releases it on exit, so concurrent ollama runs serialize instead of colliding.
//
// Modeled on the proven exclusive-create-lockfile + staleness-recovery lock in the takahe repo's
// scripts/graph-node.mjs. Plain ESM (NOT TypeScript): `it.js` is run by bare `node` and cannot
// import `.ts`. Uses only the Node stdlib.

import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The contended resource is a specific ollama daemon (its GPU). Key the lock by host so two
// different daemons don't block each other, but everything hitting the same daemon serializes.
export function defaultLockPath(ollamaHost) {
  const key = createHash('sha1').update(String(ollamaHost)).digest('hex').slice(0, 12);
  return join(tmpdir(), `gth-it-ollama-${key}.lock`);
}

// OPS-25 — is the recorded holder still running?
//
// `process.kill(pid, 0)` sends no signal; it probes for the process and reports via errno. The
// time-based staleMs below can only reclaim a crashed holder after the full 30 min, which wedges
// every subsequent ollama run in the meantime — exactly what happened when a runner was SIGTERMed
// by a harness timeout mid-run and left its lockfile behind. A holder that provably no longer
// exists is stale NOW, whatever its age.
//
// Every uncertain case answers "alive", so the time-based rule stays the backstop and a LIVE
// holder is never stolen:
//   - EPERM       → the process exists, just isn't ours (different uid) → alive.
//   - malformed / missing / non-integer pid → we know nothing → treat as held.
//   - pid reuse   → an unrelated process now owns the number → alive → falls back to staleMs.
// The lock is machine-local (tmpdir), so cross-host pid ambiguity does not arise; a shared tmpdir
// across pid namespaces would, and staleMs still covers it.
export function isHolderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

// staleMs / waitMs are BIG on purpose: a legit `it ollama` run holds the lock for the entire
// (synchronous, execSync-blocked) vitest run — minutes. staleMs must EXCEED the longest legit
// hold so a live holder is never stolen; waitMs must let a waiter outlast a legit holder.
//
// NOTE: no heartbeat/setInterval refresh — `it.js` runs vitest via a blocking execSync, so no
// timer could fire mid-run. That is exactly why staleMs is large instead of refreshing.
export function createOllamaLock({
  lockPath,
  staleMs = 30 * 60_000, // 30 min: steal only a clearly-crashed holder
  waitMs = 30 * 60_000, // 30 min: how long a waiter blocks before dying loud
  log = console.log,
} = {}) {
  async function acquire() {
    const deadline = Date.now() + waitMs;
    let lastNotice = 0;
    for (;;) {
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), {
          flag: 'wx',
        });
        let released = false;
        return () => {
          // release fn — MUST be sync (used in an 'exit' hook)
          if (released) return;
          released = true;
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Held. Steal only if clearly stale (crashed holder) — either provably gone (OPS-25) or
        // past the time-based backstop.
        try {
          const info = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (!isHolderAlive(info.pid)) {
            log(`==> reclaiming ollama GPU lock from dead pid ${info.pid} (lock ${lockPath})`);
            unlinkSync(lockPath);
            continue;
          }
          if (Date.now() - info.at > staleMs) {
            unlinkSync(lockPath);
            continue;
          }
          if (Date.now() - lastNotice > 30_000) {
            // loud, periodic "still waiting"
            log(
              `==> waiting for ollama GPU lock held by pid ${info.pid} (${Math.round(
                (Date.now() - info.at) / 1000
              )}s); lock ${lockPath}`
            );
            lastNotice = Date.now();
          }
        } catch {
          /* mid-write or malformed — treat as held, wait */
        }
        if (Date.now() > deadline) {
          throw new Error(
            `ollama GPU lock still held after ${Math.round(
              waitMs / 1000
            )}s (lock ${lockPath}); another ollama run is in progress — retry shortly, or delete a stale lock file.`,
            { cause: e }
          );
        }
        await sleep(200 + Math.floor(Math.random() * 200));
      }
    }
  }
  return { acquire, lockPath };
}
