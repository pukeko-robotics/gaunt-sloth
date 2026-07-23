import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

// Real fs / real temp dir per the debugDump precedent — only `os.homedir()` is mocked (pointed at a
// fresh mkdtemp'd dir), so `ensureGlobalGslothDir()` and the crash-dir path construction it drives
// are exercised for real, without touching the developer's actual `~/.gsloth`. See debugDump.spec.ts
// for why `vi.hoisted` is needed (this file statically imports `tmpdir` from 'node:os').
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: homedirMock };
});

const SECRET = 'sk-ant-UNITTESTSECRETSECRET1234567890';

describe('utils/writeCrashSnapshot (GS2-48)', () => {
  let homeDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    homeDir = mkdtempSync(resolve(tmpdir(), 'gsloth-crash-home-'));
    homedirMock.mockReturnValue(homeDir);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('writes a REDACTED crash.json under ~/.gsloth/debug-dumps/crash-<timestamp>/ with error + stack', async () => {
    const { writeCrashSnapshot } = await import('#src/utils/debugDump.js');
    const { debugLog } = await import('#src/utils/debugUtils.js');

    // A debugLog line carrying the secret — must appear in the tail, but REDACTED.
    debugLog(`GS2-48 marker: connecting with ${SECRET}`);

    const config = { llm: { type: 'anthropic', apiKey: SECRET }, modelDisplayName: 'test-model' };
    const error = new Error(`crashed while using ${SECRET} in the request`);

    const { crashDir, crashFile } = writeCrashSnapshot({
      error,
      origin: 'uncaughtException',
      config,
      modelDisplayName: 'test-model',
      transcriptTail: [{ role: 'user', content: `here is a token ${SECRET}` }],
    });

    // Lives under the GLOBAL dir, in a `crash-`-prefixed, filesystem-safe timestamped dir.
    expect(crashDir).toContain(resolve(homeDir, '.gsloth', 'debug-dumps'));
    expect(basename(crashDir)).toMatch(/^crash-/);
    expect(basename(crashDir)).not.toMatch(/[:.]/);
    expect(existsSync(crashFile)).toBe(true);

    const raw = readFileSync(crashFile, 'utf8');
    // The secret must appear NOWHERE in the file, and the redaction marker must be present.
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('<redacted>');

    const parsed = JSON.parse(raw);
    expect(parsed.kind).toBe('crash');
    expect(parsed.origin).toBe('uncaughtException');
    // Error survived the redaction walk (message + stack are non-enumerable on a raw Error).
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toContain('crashed while using');
    expect(parsed.error.message).toContain('<redacted>');
    expect(typeof parsed.error.stack).toBe('string');
    expect(parsed.error.stack).toContain('Error:');
    expect(parsed.error.stack).not.toContain(SECRET);
    // env/version present.
    expect(parsed.env.model).toBe('test-model');
    expect(parsed.env.nodeVersion).toBe(process.version);
    expect(parsed.env.platform).toBe(process.platform);
    // Config secret field masked in place (key kept, value redacted).
    expect(parsed.config.llm.apiKey).toBe('<redacted>');
    expect(parsed.config.llm.type).toBe('anthropic');
    // debugLog tail present and redacted.
    expect(Array.isArray(parsed.debugLogTail)).toBe(true);
    const tailText = parsed.debugLogTail.join('\n');
    expect(tailText).toContain('GS2-48 marker');
    expect(tailText).not.toContain(SECRET);
    // Transcript tail present and redacted.
    expect(JSON.stringify(parsed.transcriptTail)).not.toContain(SECRET);
    expect(JSON.stringify(parsed.transcriptTail)).toContain('<redacted>');
  });

  it('normalizes a non-Error rejection reason (string) without throwing', async () => {
    const { writeCrashSnapshot } = await import('#src/utils/debugDump.js');

    const { crashFile } = writeCrashSnapshot({
      error: 'plain string rejection reason',
      origin: 'unhandledRejection',
    });

    const parsed = JSON.parse(readFileSync(crashFile, 'utf8'));
    expect(parsed.origin).toBe('unhandledRejection');
    expect(parsed.error.name).toBe('NonError');
    expect(parsed.error.message).toBe('plain string rejection reason');
    // No session context registered → config/transcript are absent, not a crash.
    expect(parsed.config).toBeNull();
    expect(parsed.transcriptTail).toBeNull();
  });

  it('never throws on a circular / non-JSON-safe config (e.g. a live client object)', async () => {
    const { writeCrashSnapshot } = await import('#src/utils/debugDump.js');

    const circular: Record<string, unknown> = { modelDisplayName: 'test-model' };
    circular.self = circular;
    circular.doSomething = function namedFn() {};

    let crashFile = '';
    expect(() => {
      ({ crashFile } = writeCrashSnapshot({
        error: new Error('boom'),
        origin: 'uncaughtException',
        config: circular,
      }));
    }).not.toThrow();
    expect(existsSync(crashFile)).toBe(true);
    // Circular ref was broken, not left to blow up JSON.stringify.
    expect(readFileSync(crashFile, 'utf8')).toContain('[Circular]');
  });
});
