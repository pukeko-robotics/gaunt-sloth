import { describe, expect, it } from 'vitest';
import { buildScrubbedEnv, shouldScrubEnvVar } from '#src/tools/shell/env.js';

describe('shouldScrubEnvVar', () => {
  it('scrubs explicit provider/cloud credentials', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'MISTRAL_API_KEY',
      'OPENROUTER_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AZURE_OPENAI_API_KEY',
    ]) {
      expect(shouldScrubEnvVar(name), name).toBe(true);
    }
  });

  it('scrubs by wildcard suffix (unknown provider keys)', () => {
    expect(shouldScrubEnvVar('SOMENEWPROVIDER_API_KEY')).toBe(true);
    expect(shouldScrubEnvVar('FOO_SECRET')).toBe(true);
    expect(shouldScrubEnvVar('BAR_TOKEN')).toBe(true);
    expect(shouldScrubEnvVar('MY_SECRET_KEY')).toBe(true);
  });

  it('keeps generic dev env intact', () => {
    for (const name of [
      'PATH',
      'HOME',
      'SHELL',
      'LANG',
      'PWD',
      'NODE_ENV',
      'npm_config_registry',
    ]) {
      expect(shouldScrubEnvVar(name), name).toBe(false);
    }
  });

  it('keeps GITHUB_TOKEN / GH_TOKEN (needed by gh providers)', () => {
    expect(shouldScrubEnvVar('GITHUB_TOKEN')).toBe(false);
    expect(shouldScrubEnvVar('GH_TOKEN')).toBe(false);
  });
});

describe('buildScrubbedEnv', () => {
  it('removes credentials and preserves the rest', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-other',
      GITHUB_TOKEN: 'ghp_keepme',
      RANDOM_TOKEN: 'should-go',
    };
    const out = buildScrubbedEnv(source);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/x');
    expect(out.GITHUB_TOKEN).toBe('ghp_keepme');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.RANDOM_TOKEN).toBeUndefined();
  });
});
