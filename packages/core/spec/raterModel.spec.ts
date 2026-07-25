import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CFG-26 — `resolveRaterModel` is what makes `approvals.rater.profile` real rather than decorative.
 * These pin the two properties that are invisible to build/lint/type-check:
 *  1. it never silently degrades to the session model (GS2-62), and
 *  2. it does not leave the session re-rooted at whatever dir its subsidiary `initConfig` discovered.
 */
const initConfigMock = vi.fn();
vi.mock('#src/config/loader.js', () => ({ initConfig: initConfigMock }));

const systemUtilsMock = {
  peekProjectDir: vi.fn(),
  setProjectDir: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/** A model that looks usable to the rater (it only ever calls `withStructuredOutput`). */
const usableModel = () => ({ withStructuredOutput: vi.fn() });

describe('resolveRaterModel (CFG-26)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.peekProjectDir.mockReturnValue('/session/root');
  });

  const load = async () => (await import('#src/core/shell/raterModel.js')).resolveRaterModel;

  it("loads the named profile and returns THAT profile's model", async () => {
    const model = usableModel();
    initConfigMock.mockResolvedValue({ llm: model });

    const resolveRaterModel = await load();
    expect(await resolveRaterModel('safety-rater')).toBe(model);
    // Resolved as an identity profile — the same mechanism `-i <name>` uses.
    expect(initConfigMock).toHaveBeenCalledWith({ identityProfile: 'safety-rater' });
  });

  it('throws when the profile resolves to a config with NO usable model (never returns undefined)', async () => {
    // Returning undefined here would be worse than throwing: `rateShellCommand` falls back to
    // `config.llm` when its `model` option is undefined, so the user would silently get the weak
    // session model they were trying to replace.
    initConfigMock.mockResolvedValue({ llm: undefined });
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('safety-rater')).rejects.toThrow(
      /no usable model|approvals\.rater\.profile/
    );
  });

  it('throws when the profile config is not a usable chat model object', async () => {
    initConfigMock.mockResolvedValue({ llm: { notAModel: true } });
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('safety-rater')).rejects.toThrow(/no usable model/);
  });

  it('wraps a load failure with the profile name and preserves the cause', async () => {
    const cause = new Error('boom');
    initConfigMock.mockRejectedValue(cause);
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('typo-rater')).rejects.toThrow(/typo-rater/);
    await expect(resolveRaterModel('typo-rater')).rejects.toThrow(/boom/);
  });

  describe('project-dir discipline — a rater sub-config must never re-root the session', () => {
    it('restores the project dir after a successful load', async () => {
      initConfigMock.mockResolvedValue({ llm: usableModel() });
      const resolveRaterModel = await load();
      await resolveRaterModel('safety-rater');
      // `initConfig` calls setProjectDir(discovered) internally; the LAST call here must put the
      // session's own root back, or every getProjectDir() consumer (prompts, outputs, the shell
      // allow-list file, debug dumps) silently repoints at the rater profile's discovery result.
      expect(systemUtilsMock.setProjectDir).toHaveBeenLastCalledWith('/session/root');
    });

    it('restores the project dir even when the load THROWS', async () => {
      initConfigMock.mockRejectedValue(new Error('boom'));
      const resolveRaterModel = await load();
      await expect(resolveRaterModel('safety-rater')).rejects.toThrow();
      expect(systemUtilsMock.setProjectDir).toHaveBeenLastCalledWith('/session/root');
    });

    it('restores an UNSET project dir as unset, not pinned to cwd', async () => {
      // getProjectDir() would collapse "unset" into an explicit cwd; peekProjectDir keeps the
      // distinction, so a global-only / no-config session stays cwd-dynamic afterwards.
      systemUtilsMock.peekProjectDir.mockReturnValue(undefined);
      initConfigMock.mockResolvedValue({ llm: usableModel() });
      const resolveRaterModel = await load();
      await resolveRaterModel('safety-rater');
      expect(systemUtilsMock.setProjectDir).toHaveBeenLastCalledWith(undefined);
    });
  });
});
