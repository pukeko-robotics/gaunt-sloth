import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * CFG-89 — the directory a run's prompt files are looked up in first is exactly the directory its
 * global config layer was read from, and only on a `--global` run.
 */
describe('CFG-89 — globalPromptDir', () => {
  const globalDir = resolve(homedir(), '.gsloth');

  it('is the global profile directory for --global with an identity profile', async () => {
    const { globalPromptDir } = await import('#src/config/globalPromptDir.js');
    expect(globalPromptDir(true, ' coder ')).toBe(resolve(globalDir, '.gsloth-settings', 'coder'));
  });

  it('is ~/.gsloth itself for --global without a profile', async () => {
    const { globalPromptDir } = await import('#src/config/globalPromptDir.js');
    expect(globalPromptDir(true)).toBe(globalDir);
  });

  it('is undefined when the run is not --global, profile or not', async () => {
    const { globalPromptDir } = await import('#src/config/globalPromptDir.js');
    expect(globalPromptDir(false, 'coder')).toBeUndefined();
    expect(globalPromptDir(undefined)).toBeUndefined();
  });
});
