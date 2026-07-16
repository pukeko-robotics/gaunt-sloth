import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

/**
 * TLS trust config (custom CA + insecure latch). `buildDispatcherOptions` is pure (aside from the
 * injected cert reader) and carries the ca-merge / insecure-precedence / missing-file logic;
 * `installMcpTlsTrust` layers the fail-soft warnings, the loud insecure warning, the process-global
 * `setGlobalDispatcher`, and the install-once guard on top.
 */

// undici — the dispatcher install site. Stubbed so we assert on the Agent options without touching
// the real global dispatcher (which would leak across the whole test process). vi.hoisted because
// the module-under-test is imported statically (above the const-init that plain mocks would need).
const { setGlobalDispatcherMock, AgentMock, readFileSyncMock } = vi.hoisted(() => ({
  setGlobalDispatcherMock: vi.fn(),
  AgentMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));
vi.mock('undici', () => ({
  Agent: AgentMock,
  setGlobalDispatcher: setGlobalDispatcherMock,
}));

const consoleUtilsMock = vi.hoisted(() => ({
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);
vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({ debugLog: vi.fn() }));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({ getProjectDir: () => '/proj' }));

vi.mock('node:fs', () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));

import {
  buildDispatcherOptions,
  installMcpTlsTrust,
  resetMcpTlsTrustForTests,
} from '#src/mcp/tlsTrust.js';

const ROOTS = ['ROOT_A', 'ROOT_B'];

describe('buildDispatcherOptions (pure)', () => {
  it('returns null when there is no tls block', () => {
    expect(buildDispatcherOptions(undefined, () => 'x', ROOTS)).toBeNull();
  });

  it('returns null when no cert is configured and verification stays at its secure default', () => {
    expect(buildDispatcherOptions({ extraCaCerts: [] }, () => 'x', ROOTS)).toBeNull();
  });

  it('merges default roots FIRST, then the user certs (ca replaces the store)', () => {
    const built = buildDispatcherOptions(
      { extraCaCerts: ['a.crt', 'b.crt'] },
      (p) => `PEM(${p})`,
      ROOTS
    );
    expect(built).not.toBeNull();
    expect(built!.ca).toEqual(['ROOT_A', 'ROOT_B', 'PEM(a.crt)', 'PEM(b.crt)']);
    expect(built!.rejectUnauthorized).toBe(true);
    expect(built!.loadedCount).toBe(2);
    expect(built!.failures).toEqual([]);
  });

  it('records an unreadable cert as a failure and skips it (fail-soft)', () => {
    const built = buildDispatcherOptions(
      { extraCaCerts: ['good.crt', 'missing.crt'] },
      (p) => {
        if (p === 'missing.crt') throw new Error('ENOENT');
        return `PEM(${p})`;
      },
      ROOTS
    );
    expect(built!.ca).toEqual(['ROOT_A', 'ROOT_B', 'PEM(good.crt)']);
    expect(built!.loadedCount).toBe(1);
    expect(built!.failures).toEqual([{ path: 'missing.crt', message: 'ENOENT' }]);
  });

  it('propagates failures (non-null) even when every cert fails and verification stays secure', () => {
    const built = buildDispatcherOptions(
      { extraCaCerts: ['missing.crt'] },
      () => {
        throw new Error('ENOENT');
      },
      ROOTS
    );
    // Non-null so the caller can WARN about the bad path; loadedCount 0 means it won't install.
    expect(built).not.toBeNull();
    expect(built!.loadedCount).toBe(0);
    expect(built!.rejectUnauthorized).toBe(true);
    expect(built!.failures).toEqual([{ path: 'missing.crt', message: 'ENOENT' }]);
  });

  it('still installs (roots only) when the sole cert is unreadable BUT verification is disabled', () => {
    const built = buildDispatcherOptions(
      { extraCaCerts: ['missing.crt'], rejectUnauthorized: false },
      () => {
        throw new Error('ENOENT');
      },
      ROOTS
    );
    expect(built).not.toBeNull();
    expect(built!.ca).toEqual(['ROOT_A', 'ROOT_B']);
    expect(built!.rejectUnauthorized).toBe(false);
  });

  it('returns non-null for the insecure latch alone (no certs)', () => {
    const built = buildDispatcherOptions({ rejectUnauthorized: false }, () => 'x', ROOTS);
    expect(built).not.toBeNull();
    expect(built!.rejectUnauthorized).toBe(false);
    expect(built!.ca).toEqual(ROOTS);
  });
});

describe('installMcpTlsTrust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMcpTlsTrustForTests();
  });

  const cfg = (tls: GthConfig['tls']): GthConfig => ({ tls }) as GthConfig;

  it('does nothing when there is no tls block', () => {
    installMcpTlsTrust(cfg(undefined));
    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
  });

  // getProjectDir is mocked to a POSIX literal ('/proj'); tlsTrust.ts resolves the cert path with
  // node:path's native resolve(), which treats a leading-slash string as drive-relative on win32
  // (-> 'D:\proj\support\ca.crt'). A real getProjectDir() returns a platform-native path, so this
  // is a test-fixture gap, not a real bug (same class as the deepAgentPermissions win32 skips).
  it.skipIf(process.platform === 'win32')(
    'installs a global dispatcher whose ca includes the read cert, no insecure warning',
    () => {
      readFileSyncMock.mockReturnValue('USER_PEM');
      installMcpTlsTrust(cfg({ extraCaCerts: ['support/ca.crt'] }));

      expect(readFileSyncMock).toHaveBeenCalledWith('/proj/support/ca.crt', 'utf8');
      expect(AgentMock).toHaveBeenCalledTimes(1);
      const opts = AgentMock.mock.calls[0][0] as {
        connect: { ca: string[]; rejectUnauthorized: boolean };
      };
      expect(opts.connect.ca).toContain('USER_PEM');
      expect(opts.connect.rejectUnauthorized).toBe(true);
      expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
      // No security warning for the secure (add-a-CA) path.
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    }
  );

  it('emits a loud security warning (naming LLM calls) when verification is disabled', () => {
    installMcpTlsTrust(cfg({ rejectUnauthorized: false }));
    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
    const warning = consoleUtilsMock.displayWarning.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toMatch(/DISABLED/);
    expect(warning).toMatch(/LLM/);
  });

  it('warns about an unreadable cert and, with nothing else to do, installs nothing', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    installMcpTlsTrust(cfg({ extraCaCerts: ['nope.crt'] }));

    const warning = consoleUtilsMock.displayWarning.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toMatch(/could not read CA certificate 'nope.crt'/);
    // Secure default + no readable cert ⇒ nothing actionable ⇒ no dispatcher replacement.
    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
  });

  // Home-dir expansion joins with node:path's native join(), so the result is
  // backslash-separated on win32 and won't end with '/certs/ca.crt'. Same test-fixture-literal
  // class as above, not a real bug.
  it.skipIf(process.platform === 'win32')(
    'expands a ~-prefixed cert path against the home dir',
    () => {
      readFileSyncMock.mockReturnValue('USER_PEM');
      installMcpTlsTrust(cfg({ extraCaCerts: ['~/certs/ca.crt'] }));
      const [readPath] = readFileSyncMock.mock.calls[0] as [string, string];
      expect(readPath.endsWith('/certs/ca.crt')).toBe(true);
      expect(readPath.startsWith('~')).toBe(false);
    }
  );

  it('is idempotent — a second call does not re-install or re-warn', () => {
    installMcpTlsTrust(cfg({ rejectUnauthorized: false }));
    installMcpTlsTrust(cfg({ rejectUnauthorized: false }));
    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
  });
});
