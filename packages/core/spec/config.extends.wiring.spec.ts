import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * GS2-41 — end-to-end WIRING test: proves `initConfig` actually invokes profile-inheritance
 * composition in the right place, so `extends` is resolved WITHIN the profile-dir layer and the
 * GS2-33 outer precedence still holds (`CLI > profile(base+child) > global > defaults`). The direct
 * `resolveConfigExtends` unit tests prove the engine; this proves it is wired.
 *
 * Hermetic: real node:fs + `INIT_CWD` drive the real up-tree profile walk + extends composition +
 * global underlay + CLI overlay. Only the Anthropic SDK is mocked (no API key) and the GLOBAL config
 * read-path is redirected to a temp dir we control (so a host `~/.gsloth` can never bleed in).
 */
const hoisted = vi.hoisted(() => ({ globalDir: '' }));

const ChatAnthropicMock = vi.fn(function ChatAnthropicMock() {
  return { instance: 'anthropic', verbose: false };
});
vi.mock('@langchain/anthropic', () => ({ ChatAnthropic: ChatAnthropicMock }));

vi.mock('#src/utils/globalConfigUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/globalConfigUtils.js')>();
  const { resolve: resolvePath } = await import('node:path');
  return {
    ...actual,
    getGlobalGslothConfigReadPath: (filename: string) => resolvePath(hoisted.globalDir, filename),
  };
});

describe('GS2-41 profile inheritance — initConfig wiring', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-extends-wire-'));
    mkdirSync(resolve(root, '.git'), { recursive: true });
    hoisted.globalDir = resolve(root, 'globalhome');
    mkdirSync(hoisted.globalDir, { recursive: true });
    process.env.INIT_CWD = root;
    ChatAnthropicMock.mockClear();
  });

  afterEach(() => {
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const writeProfile = (name: string, config: Record<string, unknown>): void => {
    const dir = resolve(root, '.gsloth', '.gsloth-settings', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.gsloth.config.json'), JSON.stringify(config));
  };

  it('composes base + child (extends) as the project layer, with global under and CLI over', async () => {
    // Base profile: full setup incl. the llm the child will inherit.
    writeProfile('uni-mcp', {
      llm: { type: 'anthropic', model: 'base-model' },
      streamOutput: true,
      organization: { name: 'BaseOrg', locale: 'en' },
    });
    // Child profile: only a delta — overrides the org name, inherits locale + llm + streamOutput,
    // and sets its own writeOutputToFile (which the CLI flag must still be able to override).
    writeProfile('uni-test-mari', {
      extends: 'uni-mcp',
      organization: { name: 'MariOrg' },
      writeOutputToFile: 'profile.md',
    });
    // Global layer: a field neither profile sets (timezone) proves the global underlays the composed
    // profile; a field the profile DOES set (org name) proves the profile still wins over global.
    writeFileSync(
      resolve(hoisted.globalDir, '.gsloth.config.json'),
      JSON.stringify({ organization: { name: 'GlobalOrg', timezone: 'UTC' } })
    );

    const { initConfig } = await import('#src/config.js');
    const config = await initConfig({
      identityProfile: 'uni-test-mari',
      writeOutputToFile: 'cli.md',
    });

    // extends resolved: a base-only field is present on the child's effective config.
    expect(config.streamOutput).toBe(true);
    // Nested merge across all layers: child override wins the name, base supplies locale, global-only
    // timezone underlays. => CLI > profile(child > base) > global.
    expect(config.organization).toEqual({ name: 'MariOrg', locale: 'en', timezone: 'UTC' });
    // CLI flag overlays the composed profile layer (GS2-33 outer precedence intact).
    expect(config.writeOutputToFile).toBe('cli.md');
    // The llm was inherited from the base profile and built via the (mocked) provider.
    expect(ChatAnthropicMock).toHaveBeenCalledTimes(1);
    expect(ChatAnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'base-model' })
    );
  });

  it('CFG-36: a profile whose extends base is missing RAISES out of initConfig, catchably', async () => {
    // The acceptance this node turns on: a bad profile must be classifiable by the caller, so
    // `gth eval --judge <profile>` can report it as a HARNESS error (exit 2) rather than as the
    // graded product failing (exit 1). A profile whose `extends` base is gone is a bad profile on
    // any plain reading, and it used to end the process from inside config discovery — the same
    // BATCH-11 collapse the node removes for a profile with no config at all.
    //
    // This is the level that proves it, through the REAL loader rather than the composer alone: the
    // raise has to survive initConfig's JSON branch, whose catch would otherwise fall through to the
    // next config FORMAT and end in the terminal "No configuration file found" failure — hiding the
    // clearly-worded real problem. Asserting the error TYPE (not merely that something threw) is
    // what makes it discriminating: the shape this replaced printed the message, called `exit(1)`
    // and threw a generic sentinel, so a bare rejects.toThrow() would pass against it unchanged.
    writeProfile('orphan', { extends: 'no-such-base', llm: { type: 'anthropic' } });

    const { initConfig, isConfigDiscoveryError } = await import('#src/config.js');
    const error = await initConfig({ identityProfile: 'orphan' }).then(
      () => {
        throw new Error('expected a ConfigDiscoveryError, but initConfig resolved');
      },
      (e: unknown) => e
    );

    expect(isConfigDiscoveryError(error)).toBe(true);
    expect((error as Error).message).toMatch(/"no-such-base".*was not found/i);
    // CFG-47 — the original `ConfigExtendsError` travels as `cause`. Asserted because re-raising by
    // message alone is silently revertible: the wrapper still carries the right words, and the
    // underlying error and its stack are simply gone for anyone who wants them.
    expect((error as Error).cause).toBeInstanceOf(Error);
    // Never reached the provider: the run stops at discovery, it does not grade under a half-built
    // config.
    expect(ChatAnthropicMock).not.toHaveBeenCalled();
  });
});
