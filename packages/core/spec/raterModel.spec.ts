import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CFG-26 — `resolveRaterModel` is what makes `approvals.rater` real rather than decorative.
 * These pin the two properties that are invisible to build/lint/type-check:
 *  1. it never silently degrades to the session model (GS2-62), and
 *  2. it does not leave the session re-rooted at whatever dir its subsidiary `initConfig` discovered.
 *
 * [[EXT-127]] — **it serves two keys now, so every call here passes the one it is speaking for.**
 * `configKey` is a required parameter precisely so a call site cannot report the other key's name,
 * and **no spec in this file is type-checked** (`packages/core/tsconfig.json` includes `src/` only,
 * and the lint config gives the test block a type-agnostic parser), so a stale one-argument call
 * silently made `configKey` `undefined` and put the word *undefined* into the very sentence these
 * cells assert on. The key each case passes is therefore part of what it is testing.
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
    expect(await resolveRaterModel('safety-rater', 'approvals.rater')).toBe(model);
    // Resolved as an identity profile — the same mechanism `-i <name>` uses.
    expect(initConfigMock).toHaveBeenCalledWith({ identityProfile: 'safety-rater' });
  });

  it('throws when the profile resolves to a config with NO usable model (never returns undefined)', async () => {
    // Returning undefined here would be worse than throwing: `rateShellCommand` falls back to
    // `config.llm` when its `model` option is undefined, so the user would silently get the weak
    // session model they were trying to replace.
    initConfigMock.mockResolvedValue({ llm: undefined });
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('safety-rater', 'approvals.rater')).rejects.toThrow(
      /no usable model/
    );
    // The key is the only thing the user can act on, so the sentence has to name the one they
    // wrote. The alternation that used to stand here offered `approvals.rater.profile`, a key the
    // message has not contained for some time — an alternative that can never match is a branch of
    // an assertion that cannot fail.
    await expect(resolveRaterModel('safety-rater', 'approvals.rater')).rejects.toThrow(
      /remove approvals\.rater to use the session model/
    );
  });

  /**
   * [[EXT-127]] — **the second key, which nothing asserted at all.**
   *
   * `approvals.alignmentChecker` is the reason `configKey` became a parameter: the two keys resolve
   * identically and fail identically, and the ONLY difference between them is the sentence the user
   * is shown. So the one thing worth pinning is exactly that — that a checker failure names the
   * checker's key and not the rater's, which is the shape a defaulted parameter would produce and
   * the one a user cannot debug their way out of.
   */
  it('names the CHECKER’s key, not the rater’s, when the checker’s profile is unusable', async () => {
    initConfigMock.mockResolvedValue({ llm: undefined });
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('big-checker', 'approvals.alignmentChecker')).rejects.toThrow(
      /remove approvals\.alignmentChecker to use the session model/
    );
  });

  /** The same for the wrapped load failure, which is the other sentence a user meets. */
  it('names the CHECKER’s key when its profile cannot be loaded at all', async () => {
    initConfigMock.mockRejectedValue(new Error('boom'));
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('big-checker', 'approvals.alignmentChecker')).rejects.toThrow(
      /named by approvals\.alignmentChecker/
    );
  });

  it('throws when the profile config is not a usable chat model object', async () => {
    initConfigMock.mockResolvedValue({ llm: { notAModel: true } });
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('safety-rater', 'approvals.rater')).rejects.toThrow(
      /no usable model/
    );
  });

  it('wraps a load failure with the profile name and preserves the cause', async () => {
    const cause = new Error('boom');
    initConfigMock.mockRejectedValue(cause);
    const resolveRaterModel = await load();
    await expect(resolveRaterModel('typo-rater', 'approvals.rater')).rejects.toThrow(/typo-rater/);
    await expect(resolveRaterModel('typo-rater', 'approvals.rater')).rejects.toThrow(/boom/);
  });

  describe('project-dir discipline — a rater sub-config must never re-root the session', () => {
    it('restores the project dir after a successful load', async () => {
      initConfigMock.mockResolvedValue({ llm: usableModel() });
      const resolveRaterModel = await load();
      await resolveRaterModel('safety-rater', 'approvals.rater');
      // `initConfig` calls setProjectDir(discovered) internally; the LAST call here must put the
      // session's own root back, or every getProjectDir() consumer (prompts, outputs, the shell
      // allow-list file, debug dumps) silently repoints at the rater profile's discovery result.
      expect(systemUtilsMock.setProjectDir).toHaveBeenLastCalledWith('/session/root');
    });

    it('restores the project dir even when the load THROWS', async () => {
      initConfigMock.mockRejectedValue(new Error('boom'));
      const resolveRaterModel = await load();
      await expect(resolveRaterModel('safety-rater', 'approvals.rater')).rejects.toThrow();
      expect(systemUtilsMock.setProjectDir).toHaveBeenLastCalledWith('/session/root');
    });

    it('restores an UNSET project dir as unset, not pinned to cwd', async () => {
      // getProjectDir() would collapse "unset" into an explicit cwd; peekProjectDir keeps the
      // distinction, so a global-only / no-config session stays cwd-dynamic afterwards.
      systemUtilsMock.peekProjectDir.mockReturnValue(undefined);
      initConfigMock.mockResolvedValue({ llm: usableModel() });
      const resolveRaterModel = await load();
      await resolveRaterModel('safety-rater', 'approvals.rater');
      expect(systemUtilsMock.setProjectDir).toHaveBeenLastCalledWith(undefined);
    });
  });
});
