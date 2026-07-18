import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Real fs / real temp dir per the brief — only `os.homedir()` is mocked (pointed at a fresh
// mkdtemp'd dir), so `ensureGlobalGslothDir()` (and therefore the archive path construction it
// drives) is exercised for real, without touching the developer's actual `~/.gsloth`. `vi.hoisted`
// avoids a TDZ error: this file also statically imports `tmpdir` from 'node:os', so the mock
// factory can run during that very import, before a plain top-level `const` would be initialized.
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: homedirMock };
});

describe('utils/debugDump', () => {
  let homeDir: string;
  let notGitDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    homeDir = mkdtempSync(resolve(tmpdir(), 'gsloth-debugdump-home-'));
    notGitDir = mkdtempSync(resolve(tmpdir(), 'gsloth-debugdump-notgit-'));
    homedirMock.mockReturnValue(homeDir);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(notGitDir, { recursive: true, force: true });
  });

  it('writes transcript, config, env and debug-log files under the GLOBAL ~/.gsloth/debug-dumps/<timestamp>/', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');
    const { debugLog } = await import('#src/utils/debugUtils.js');
    debugLog('GS2-46 debugDump writer test marker');

    const transcript = [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi there' },
    ];
    const config = { modelDisplayName: 'test-model', agent: { backend: 'lean' } };

    const { archiveDir } = writeDebugDump({
      transcript,
      config,
      modelDisplayName: 'test-model',
      cwd: notGitDir, // not a git repo — exercises the "omit git-state" path
    });

    // Archive lives under the GLOBAL dir, not some cwd-relative one.
    expect(archiveDir).toContain(resolve(homeDir, '.gsloth', 'debug-dumps'));
    expect(existsSync(archiveDir)).toBe(true);

    const transcriptOut = JSON.parse(readFileSync(resolve(archiveDir, 'transcript.json'), 'utf8'));
    expect(transcriptOut).toEqual(transcript);

    const configOut = JSON.parse(readFileSync(resolve(archiveDir, 'config.json'), 'utf8'));
    expect(configOut).toEqual(config);

    const envOut = JSON.parse(readFileSync(resolve(archiveDir, 'env.json'), 'utf8'));
    expect(envOut).toMatchObject({
      nodeVersion: process.version,
      platform: process.platform,
      model: 'test-model',
    });
    expect(envOut.gthVersion).toBeDefined();

    const debugLogOut = readFileSync(resolve(archiveDir, 'debug-log.txt'), 'utf8');
    expect(debugLogOut).toContain('GS2-46 debugDump writer test marker');

    // Not a git repo → git-state.json must be entirely omitted, not written empty/erroring.
    expect(existsSync(resolve(archiveDir, 'git-state.json'))).toBe(false);
  });

  it('includes git-state.json (branch/remote/dirty) when run inside a git repo', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    // This test file itself runs from inside the gaunt-sloth git repo checkout.
    const { archiveDir } = writeDebugDump({
      transcript: [],
      config: {},
      modelDisplayName: 'test-model',
      cwd: process.cwd(),
    });

    const gitStatePath = resolve(archiveDir, 'git-state.json');
    expect(existsSync(gitStatePath)).toBe(true);
    const gitState = JSON.parse(readFileSync(gitStatePath, 'utf8'));
    expect(typeof gitState.branch).toBe('string');
    expect(gitState.branch.length).toBeGreaterThan(0);
    expect(typeof gitState.dirty).toBe('boolean');
  });

  it('never throws on a circular / non-JSON-safe config (e.g. a live LLM client object)', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    const circular: any = { modelDisplayName: 'test-model' };
    circular.self = circular; // circular reference
    circular.doSomething = function namedFn() {}; // a function, like a live client's methods

    expect(() =>
      writeDebugDump({
        transcript: [],
        config: circular,
        modelDisplayName: 'test-model',
        cwd: notGitDir,
      })
    ).not.toThrow();
  });

  it('never throws when config is undefined (e.g. no resolved session config available)', async () => {
    // QA-6 regression: JSON.stringify(undefined, replacer, 2) returns `undefined`, not a string,
    // so writeFileSync used to throw ERR_INVALID_ARG_TYPE for this — legitimate — input shape
    // (DebugDumpInput.config is optional upstream). Caught via the e2e fixture harness, which
    // wires the real writer with no resolved config.
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    let archiveDir = '';
    expect(() => {
      ({ archiveDir } = writeDebugDump({
        transcript: [],
        config: undefined,
        modelDisplayName: 'test-model',
        cwd: notGitDir,
      }));
    }).not.toThrow();

    const configOut = readFileSync(resolve(archiveDir, 'config.json'), 'utf8');
    expect(configOut).toBe('null');
  });

  it('writes a distinct, filesystem-safe timestamped directory on each call', async () => {
    const { writeDebugDump } = await import('#src/utils/debugDump.js');

    const first = writeDebugDump({ transcript: [], config: {}, cwd: notGitDir });
    const second = writeDebugDump({ transcript: [], config: {}, cwd: notGitDir });

    expect(first.archiveDir).not.toBe(second.archiveDir);
    // Filesystem-safe: no `:` characters (from the ISO timestamp) in the path.
    expect(first.archiveDir.includes(':')).toBe(false);
  });
});
