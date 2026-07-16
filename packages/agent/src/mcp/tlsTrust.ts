/**
 * @packageDocumentation
 * Process-global TLS trust for outbound HTTPS, driven by the `tls` config block.
 *
 * Motivation: an `http`-transport MCP server behind a private/corporate CA (e.g. a dev monolith
 * with a self-signed cert) makes Node's global `fetch` reject the connection with
 * `TypeError: fetch failed` (`SELF_SIGNED_CERT_IN_CHAIN`). The only pre-existing workaround was to
 * prepend `NODE_EXTRA_CA_CERTS=<ca.crt>` on every invocation — that env var is read ONCE at Node
 * startup, so it can't be set from config after launch.
 *
 * Node's `fetch` runs on undici and ignores `https.globalAgent`, so the CA must be installed via an
 * undici dispatcher. `@langchain/mcp-adapters` forwards only `serverName`/`headers`/`authProvider`
 * to the SDK transport (it drops the SDK's `requestInit`/`fetch` hooks), so a per-server CA is not
 * reachable through the adapter. The trust is therefore installed **process-globally** via
 * `setGlobalDispatcher`. That is acceptable for adding a CA (additive trust weakens nothing) — but
 * note the insecure latch below is global too, and so affects LLM provider calls, not only MCP.
 */

import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';

type TlsConfig = GthConfig['tls'];

/** A cert path that could not be read, with the reason (surfaced by the installer). */
export interface TlsCertFailure {
  path: string;
  message: string;
}

/** The undici `connect` options computed from a `tls` config, plus what happened while reading. */
export interface BuiltDispatcher {
  /** Node's default roots FIRST, then successfully-read user certs. `connect.ca` REPLACES the */
  /** default store, so the roots must be included or every public-CA fetch breaks. */
  ca: string[];
  /** `false` disables verification entirely (process-global). Defaults to `true`. */
  rejectUnauthorized: boolean;
  /** How many configured certs were read successfully. */
  loadedCount: number;
  /** Configured certs that could not be read (fail-soft: skipped, not fatal). */
  failures: TlsCertFailure[];
}

/**
 * Compute the undici dispatcher options from a `tls` config. Pure aside from the injected
 * `readCert` (so unit tests stub file reads): resolves nothing about the environment itself.
 *
 * Returns `null` only when NOTHING is configured — no `tls` block, or an empty `tls` with no cert
 * entries and verification left at its secure default. When certs ARE configured it always returns
 * the object (even if every read failed), so the caller can surface those `failures` rather than
 * silently swallowing a bad cert path. Whether to actually install is the caller's call:
 * `loadedCount > 0 || !rejectUnauthorized`.
 *
 * `readCert` receives each configured path verbatim and must return the PEM contents or throw.
 */
export function buildDispatcherOptions(
  tls: TlsConfig,
  readCert: (path: string) => string,
  baseRoots: readonly string[] = rootCertificates
): BuiltDispatcher | null {
  const rejectUnauthorized = tls?.rejectUnauthorized ?? true;
  const certPaths = tls?.extraCaCerts ?? [];

  // Nothing configured at all: no cert entries and verification not being disabled.
  if (certPaths.length === 0 && rejectUnauthorized) return null;

  const userCerts: string[] = [];
  const failures: TlsCertFailure[] = [];

  for (const path of certPaths) {
    try {
      userCerts.push(readCert(path));
    } catch (error) {
      failures.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    // ca REPLACES the trust store — keep the default roots or public-CA fetches (incl. the LLM
    // provider) silently break.
    ca: [...baseRoots, ...userCerts],
    rejectUnauthorized,
    loadedCount: userCerts.length,
    failures,
  };
}

// Install-once guard: the trust is process-global and set-once, so re-running resolveTools (re-init)
// must not re-replace the dispatcher nor re-emit the security warning every time.
let installed = false;

/**
 * Install the process-global undici dispatcher from `config.tls`, if any. Idempotent (installs at
 * most once per process). Fail-soft: an unreadable cert is warned about and skipped, never fatal.
 * Emits a loud security warning when verification is disabled.
 *
 * Wired into `getMcpClient` before the MCP client is created; because it is global it also covers
 * LLM/tool fetches — which is desired for the CA case and is the danger to flag for the latch.
 */
export function installMcpTlsTrust(config: GthConfig): void {
  if (installed) {
    debugLog('MCP TLS trust already installed this process; skipping.');
    return;
  }

  const built = buildDispatcherOptions(config.tls, resolveAndReadCert);
  if (!built) return;

  // Surface unreadable certs even if we end up installing nothing — a bad cert path must never be
  // swallowed silently. Warn BEFORE the "nothing actionable" bail below.
  for (const failure of built.failures) {
    displayWarning(
      `TLS: could not read CA certificate '${failure.path}' (${failure.message}); skipping it.`
    );
  }

  // Nothing left to install: every configured cert failed to read and verification is still on.
  // (Failures were already surfaced above.) Leave Node's default dispatcher untouched.
  if (built.loadedCount === 0 && built.rejectUnauthorized) return;

  installed = true;

  if (!built.rejectUnauthorized) {
    displayWarning(
      'TLS: certificate verification is DISABLED (tls.rejectUnauthorized: false). This is INSECURE ' +
        'and applies to ALL outbound HTTPS this process makes — MCP servers AND LLM provider calls. ' +
        'Use only against trusted dev endpoints; prefer tls.extraCaCerts to trust a specific CA instead.'
    );
  }

  setGlobalDispatcher(
    new Agent({ connect: { ca: built.ca, rejectUnauthorized: built.rejectUnauthorized } })
  );
  debugLog(
    `MCP TLS trust installed: ${built.loadedCount} extra CA cert(s), rejectUnauthorized=${built.rejectUnauthorized}.`
  );
}

/** Resolve a configured cert path (`~` / relative-to-project / absolute) and read it as UTF-8. */
function resolveAndReadCert(path: string): string {
  const expanded = path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
  return readFileSync(resolve(getProjectDir(), expanded), 'utf8');
}

/** Test-only: reset the install-once guard between cases. */
export function resetMcpTlsTrustForTests(): void {
  installed = false;
}
