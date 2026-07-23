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
});
