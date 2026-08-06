import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGthConfig } from '#src/config.js';

/**
 * CFG-35 — a provider that cannot be built because no API key is resolvable must raise a CATCHABLE
 * error, not kill the process.
 *
 * Every assertion here is made in-process against the thrown value. Nothing spawns a `gth` binary
 * to read an exit code: an exit code would only tell us the process died, which is the behaviour
 * being removed, and could not inspect the provider/variable fields that are the point of the
 * change.
 *
 * NOTE ON KEYS: `env` is mocked to an object this file controls, so the machine's real provider
 * keys can never leak in and flip a "no key" case to "key present". Keys are only ever asserted by
 * PRESENCE or by VARIABLE NAME — never by value, which would print a live secret into test output.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  setConsoleLevel: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const fileUtilsMock = {
  writeFileIfNotExistsWithMessages: vi.fn(),
  importExternalFile: vi.fn(),
  importFromFilePath: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  toFileSafeString: vi.fn(),
  readFileSyncWithMessages: vi.fn(),
  getGslothConfigReadPath: vi.fn().mockImplementation((path: string) => `/mock/read/${path}`),
  getGslothConfigWritePath: vi.fn().mockImplementation((path: string) => `/mock/write/${path}`),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const globalConfigUtilsMock = {
  getGlobalGslothConfigReadPath: vi
    .fn()
    .mockImplementation(() => '/mock/global-absent/no-such-config'),
  getGlobalGslothConfigWritePath: vi
    .fn()
    .mockImplementation((filename: string) => `/mock/global-write/${filename}`),
};
vi.mock('#src/utils/globalConfigUtils.js', () => globalConfigUtilsMock);

const systemUtilsMock = {
  exit: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
  setProjectDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
  isStdoutTTY: vi.fn(),
  error: vi.fn(),
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const MOCK_CWD = '/mock/current/dir';

/** A groq spec — groq's SDK validates the key in its constructor, so it is the real-world shape. */
const GROQ_CONFIG = {
  llm: { type: 'groq', model: 'openai/gpt-oss-20b' },
} as unknown as RawGthConfig;

/** The failure a provider SDK raises when it finds no key. Deliberately NOT the string we match on. */
const SDK_NO_KEY_ERROR = new Error(
  'Groq API key not found. Please set the GROQ_API_KEY environment variable'
);

describe('CFG-35 missing provider key', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    systemUtilsMock.getCurrentWorkDir.mockReturnValue(MOCK_CWD);
    systemUtilsMock.getProjectDir.mockReturnValue(MOCK_CWD);
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
    systemUtilsMock.isTTY.mockReturnValue(true);
    systemUtilsMock.isStdoutTTY.mockReturnValue(true);
    globalConfigUtilsMock.getGlobalGslothConfigReadPath.mockImplementation(
      () => '/mock/global-absent/no-such-config'
    );
    // The environment every test starts from: no provider keys at all.
    for (const key of Object.keys(systemUtilsMock.env)) {
      delete systemUtilsMock.env[key];
    }
  });

  describe('findMissingProviderKey', () => {
    it('reports the provider and its variable when nothing supplies a key', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      expect(findMissingProviderKey('groq', { model: 'openai/gpt-oss-20b' })).toEqual({
        provider: 'groq',
        envVar: 'GROQ_API_KEY',
        envVars: ['GROQ_API_KEY'],
      });
    });

    it('covers every provider whose SDK rejects a missing key in its constructor', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      // Probing the installed packages found SIX providers that fail eagerly without a key, not
      // the three the ticket named — anthropic (the common default), xai and deepseek reject it in
      // their constructors too. The classifier is descriptor-driven so it covers them all; this
      // pins that, and would go red if a descriptor lost its variable.
      expect(findMissingProviderKey('anthropic', {})).toEqual({
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        envVars: ['ANTHROPIC_API_KEY'],
      });
      expect(findMissingProviderKey('xai', {})).toEqual({
        provider: 'xai',
        envVar: 'XAI_API_KEY',
        envVars: ['XAI_API_KEY'],
      });
      expect(findMissingProviderKey('deepseek', {})).toEqual({
        provider: 'deepseek',
        envVar: 'DEEPSEEK_API_KEY',
        envVars: ['DEEPSEEK_API_KEY'],
      });
    });

    it('lists every accepted variable, highest precedence first', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      expect(findMissingProviderKey('openrouter', {})).toEqual({
        provider: 'openrouter',
        envVar: 'OPEN_ROUTER_API_KEY',
        envVars: ['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'],
      });
      expect(findMissingProviderKey('huggingface', {})).toEqual({
        provider: 'huggingface',
        envVar: 'HF_TOKEN',
        envVars: ['HF_TOKEN', 'HUGGINGFACEHUB_API_TOKEN', 'HF_API_KEY'],
      });
    });

    it('is silent when the key comes from the environment', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');
      systemUtilsMock.env.GROQ_API_KEY = 'present';

      expect(findMissingProviderKey('groq', {})).toBeUndefined();
    });

    it('is silent when the key comes from an accepted alias', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');
      systemUtilsMock.env.OPENROUTER_API_KEY = 'present';

      expect(findMissingProviderKey('openrouter', {})).toBeUndefined();
    });

    it('is silent when the config carries an inline key', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      expect(findMissingProviderKey('groq', { apiKey: 'inline' })).toBeUndefined();
    });

    it('is silent when the config-declared variable is set', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');
      systemUtilsMock.env.MY_HF_TOKEN = 'present';

      expect(
        findMissingProviderKey('huggingface', { apiKeyEnvironmentVariable: 'MY_HF_TOKEN' })
      ).toBeUndefined();
    });

    it('names the config-declared variable first when it is the one that is unset', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      expect(
        findMissingProviderKey('huggingface', { apiKeyEnvironmentVariable: 'MY_HF_TOKEN' })
      ).toEqual({
        provider: 'huggingface',
        envVar: 'MY_HF_TOKEN',
        envVars: ['MY_HF_TOKEN', 'HF_TOKEN', 'HUGGINGFACEHUB_API_TOKEN', 'HF_API_KEY'],
      });
    });

    it('is silent for providers that do not authenticate with an env-var key', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      // vertexai authenticates via gcloud ADC and ollama runs locally: there is no key to miss.
      expect(findMissingProviderKey('vertexai', {})).toBeUndefined();
      expect(findMissingProviderKey('ollama', {})).toBeUndefined();
    });

    it('is silent for a provider it does not know', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');

      expect(findMissingProviderKey('not-a-provider', {})).toBeUndefined();
      expect(findMissingProviderKey(undefined, {})).toBeUndefined();
    });

    it('treats a blank key or a blank variable value as absent', async () => {
      const { findMissingProviderKey } = await import('#src/providers/modelDiscovery.js');
      systemUtilsMock.env.GROQ_API_KEY = '   ';

      expect(findMissingProviderKey('groq', { apiKey: '  ' })).toEqual({
        provider: 'groq',
        envVar: 'GROQ_API_KEY',
        envVars: ['GROQ_API_KEY'],
      });
    });
  });

  describe('isMissingProviderKeyError', () => {
    it('recognises the error and rejects anything else', async () => {
      const { MissingProviderKeyError, isMissingProviderKeyError } =
        await import('#src/config/providerKeys.js');
      const error = new MissingProviderKeyError('nope', {
        provider: 'groq',
        envVar: 'GROQ_API_KEY',
        envVars: ['GROQ_API_KEY'],
      });

      expect(isMissingProviderKeyError(error)).toBe(true);
      expect(isMissingProviderKeyError(new Error('nope'))).toBe(false);
      expect(isMissingProviderKeyError({ provider: 'groq' })).toBe(false);
      expect(isMissingProviderKeyError(undefined)).toBe(false);
      expect(isMissingProviderKeyError(null)).toBe(false);
    });

    it('survives a duplicated module copy, where instanceof would not', async () => {
      const { isMissingProviderKeyError } = await import('#src/config/providerKeys.js');
      // What an error built by a SECOND copy of @gaunt-sloth/core looks like from here: the same
      // shape, a different class identity. A consumer resolving two copies must still classify it.
      const fromOtherCopy = Object.assign(new Error('nope'), {
        name: 'MissingProviderKeyError',
        gthMissingProviderKey: true,
        provider: 'groq',
        envVar: 'GROQ_API_KEY',
        envVars: ['GROQ_API_KEY'],
      });

      expect(isMissingProviderKeyError(fromOtherCopy)).toBe(true);
    });

    it('serializes the message alongside the machine-readable fields', async () => {
      const { MissingProviderKeyError } = await import('#src/config/providerKeys.js');
      const error = new MissingProviderKeyError('the message', {
        provider: 'openrouter',
        envVar: 'OPEN_ROUTER_API_KEY',
        envVars: ['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'],
      });

      // An Error's `message` is non-enumerable, so a plain JSON.stringify would drop it — the one
      // field a report shows a human next to the provider and the variable.
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        name: 'MissingProviderKeyError',
        message: 'the message',
        provider: 'openrouter',
        envVar: 'OPEN_ROUTER_API_KEY',
        envVars: ['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'],
      });
    });
  });

  describe('tryJsonConfig', () => {
    it('throws a catchable error naming the provider and the variable', async () => {
      vi.doMock('#src/providers/groq.js', () => ({
        processJsonConfig: vi.fn().mockRejectedValue(SDK_NO_KEY_ERROR),
        postProcessJsonConfig: undefined,
      }));
      const { tryJsonConfig } = await import('#src/config.js');
      const { isMissingProviderKeyError } = await import('#src/config/providerKeys.js');

      const error = await tryJsonConfig(GROQ_CONFIG, {}).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(isMissingProviderKeyError(error)).toBe(true);
      expect(error).toMatchObject({
        provider: 'groq',
        envVar: 'GROQ_API_KEY',
        envVars: ['GROQ_API_KEY'],
        // The message this branch has always printed, so a caller that reports it is unchanged.
        message: `Error processing LLM config: ${SDK_NO_KEY_ERROR.message}`,
      });
      // The whole point: the library did not decide to end the process, and did not print on its
      // own behalf — the caller that catches this owns both decisions.
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('keeps the original provider failure as the cause', async () => {
      vi.doMock('#src/providers/groq.js', () => ({
        processJsonConfig: vi.fn().mockRejectedValue(SDK_NO_KEY_ERROR),
        postProcessJsonConfig: undefined,
      }));
      const { tryJsonConfig } = await import('#src/config.js');

      const error = await tryJsonConfig(GROQ_CONFIG, {}).then(
        () => undefined,
        (e: unknown) => e
      );

      expect((error as Error).cause).toBe(SDK_NO_KEY_ERROR);
    });

    it('still exits when the provider fails WITH a key present', async () => {
      // The control that makes the case above mean something: same provider, same throw, key
      // present. This is an outage, not a missing secret, and it must NOT be reclassified.
      systemUtilsMock.env.GROQ_API_KEY = 'present';
      const outage = new Error('503 Service Unavailable');
      vi.doMock('#src/providers/groq.js', () => ({
        processJsonConfig: vi.fn().mockRejectedValue(outage),
        postProcessJsonConfig: undefined,
      }));
      const { tryJsonConfig } = await import('#src/config.js');
      const { isMissingProviderKeyError } = await import('#src/config/providerKeys.js');

      const error = await tryJsonConfig(GROQ_CONFIG, {}).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(isMissingProviderKeyError(error)).toBe(false);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        'Error processing LLM config: 503 Service Unavailable'
      );
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('still reports an unsupported LLM type as unsupported, key or no key', async () => {
      // A KNOWN provider whose LangChain package is not installed: every factory imports its SDK
      // inside processJsonConfig, so an unmet peer surfaces here as a module-resolution failure.
      // No key is set either, so the missing-key classifier would happily claim this one too —
      // which is why the order of the two branches is load-bearing.
      vi.doMock('#src/providers/groq.js', () => ({
        processJsonConfig: vi
          .fn()
          .mockRejectedValue(new Error("Cannot find module '@langchain/groq'")),
        postProcessJsonConfig: undefined,
      }));
      const { tryJsonConfig } = await import('#src/config.js');
      const { isMissingProviderKeyError } = await import('#src/config/providerKeys.js');

      const error = await tryJsonConfig(GROQ_CONFIG, {}).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(isMissingProviderKeyError(error)).toBe(false);
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith("LLM type 'groq' not supported.");
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('builds the model normally when the provider succeeds', async () => {
      // The happy path with no key in the environment at all: an eagerly-validating provider that
      // resolves its key some other way must be completely untouched by this change.
      vi.doMock('#src/providers/groq.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'groq' }),
        postProcessJsonConfig: undefined,
      }));
      const { tryJsonConfig } = await import('#src/config.js');

      const config = await tryJsonConfig(GROQ_CONFIG, {});

      expect(config.llm).toEqual({ type: 'groq' });
      expect(config.modelProviderType).toBe('groq');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });
  });

  describe('initConfig', () => {
    it('propagates the missing key instead of falling through to the next config format', async () => {
      // The JSON branch's catch exists to try the next FORMAT when the JSON layer cannot be read.
      // A config that read fine and named a keyless provider is not a read failure: swallowing it
      // would end in the terminal "No configuration file found" exit — uncatchable, and wrong.
      fsMock.existsSync.mockImplementation(
        (path: string) => !!path && path.includes('.gsloth.config.json')
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path && path.includes('.gsloth.config.json') ? JSON.stringify(GROQ_CONFIG) : ''
      );
      vi.doMock('#src/providers/groq.js', () => ({
        processJsonConfig: vi.fn().mockRejectedValue(SDK_NO_KEY_ERROR),
        postProcessJsonConfig: undefined,
      }));
      const { initConfig } = await import('#src/config.js');
      const { isMissingProviderKeyError } = await import('#src/config/providerKeys.js');

      const error = await initConfig({}).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(isMissingProviderKeyError(error)).toBe(true);
      expect(error).toMatchObject({ provider: 'groq', envVar: 'GROQ_API_KEY' });
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });

    it('loads a working config unchanged when no key is needed', async () => {
      // The control for the case above: same discovery, same code path, a provider that builds.
      fsMock.existsSync.mockImplementation(
        (path: string) => !!path && path.includes('.gsloth.config.json')
      );
      fsMock.readFileSync.mockImplementation((path: string) =>
        path && path.includes('.gsloth.config.json')
          ? JSON.stringify({ llm: { type: 'vertexai' } })
          : ''
      );
      vi.doMock('#src/providers/vertexai.js', () => ({
        processJsonConfig: vi.fn().mockResolvedValue({ type: 'vertexai' }),
        postProcessJsonConfig: undefined,
      }));
      const { initConfig } = await import('#src/config.js');

      const config = await initConfig({});

      expect(config.llm).toEqual({ type: 'vertexai' });
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    });
  });
});
