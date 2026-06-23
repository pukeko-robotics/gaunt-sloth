import { describe, expect, it } from 'vitest';
import { getShellJudgeSettings, isShellJudgeEnabled, type GthDevToolsConfig } from '#src/config.js';

const dt = (shell: GthDevToolsConfig['shell']): GthDevToolsConfig => ({ shell });

describe('isShellJudgeEnabled', () => {
  it('defaults OFF (undefined / bare boolean shell / object without judge)', () => {
    expect(isShellJudgeEnabled(undefined)).toBe(false);
    expect(isShellJudgeEnabled(dt(true))).toBe(false);
    expect(isShellJudgeEnabled(dt({ enabled: true }))).toBe(false);
  });

  it('enables on judge: true', () => {
    expect(isShellJudgeEnabled(dt({ enabled: true, judge: true }))).toBe(true);
  });

  it('enables on judge: { enabled: true } and stays off on { enabled: false }', () => {
    expect(isShellJudgeEnabled(dt({ enabled: true, judge: { enabled: true } }))).toBe(true);
    expect(isShellJudgeEnabled(dt({ enabled: true, judge: { enabled: false } }))).toBe(false);
    expect(isShellJudgeEnabled(dt({ enabled: true, judge: false }))).toBe(false);
  });
});

describe('getShellJudgeSettings', () => {
  it('applies safe defaults when enabled via bare boolean (autoApproveLow on, blockHigh off)', () => {
    expect(getShellJudgeSettings(dt({ enabled: true, judge: true }))).toEqual({
      enabled: true,
      autoApproveLow: true,
      blockHigh: false,
      model: undefined,
    });
  });

  it('honors object overrides', () => {
    expect(
      getShellJudgeSettings(
        dt({ enabled: true, judge: { enabled: true, autoApproveLow: false, blockHigh: true } })
      )
    ).toMatchObject({ enabled: true, autoApproveLow: false, blockHigh: true });
  });

  it('reports disabled with defaults when judge is off', () => {
    expect(getShellJudgeSettings(dt({ enabled: true }))).toMatchObject({
      enabled: false,
      autoApproveLow: true,
      blockHigh: false,
    });
  });
});
