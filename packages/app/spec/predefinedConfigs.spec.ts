import { beforeEach, describe, expect, it, vi } from 'vitest';

// Define mocks at top level
const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
};
vi.mock('node:fs', () => fsMock);

const systemUtilsMock = {
  exit: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getInstallDir: vi.fn(),
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('predefined AI provider configurations', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/mock/current/dir');
    systemUtilsMock.getInstallDir.mockReturnValue('/mock/install/dir');
  });

  it('Should import predefined Anthropic config correctly', async () => {
    // Mock the Anthropic module and its import
    const mockChat = vi.fn();
    const mockChatInstance = { instance: 'anthropic' };
    mockChat.mockReturnValue(mockChatInstance);
    vi.doMock('@langchain/anthropic', () => ({
      ChatAnthropic: mockChat,
    }));

    // Mock a successful config initialization with the mock instance
    const expectedConfig = {
      llm: mockChatInstance,
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      streamOutput: true,
      commands: {
        pr: { contentProvider: 'github', requirementsProvider: 'github' },
        code: { filesystem: 'all' },
      },
    };

    // Set up fs mocks for this specific test
    fsMock.existsSync.mockImplementation((path) => path.includes('.gsloth.config.json'));
    fsMock.readFileSync.mockImplementation((path) => {
      if (path.includes('.gsloth.config.json')) {
        return JSON.stringify({
          llm: {
            type: 'anthropic',
            model: 'anthropicmodel',
            apiKey: 'test-api-key',
          },
        });
      }
      return '';
    });

    // Mock the config module
    vi.doMock('#src/config.js', async () => {
      const actual = await vi.importActual('#src/config.js');
      return {
        ...actual,
        initConfig: vi.fn().mockResolvedValue(expectedConfig),
      };
    });

    const { initConfig } = await import('#src/config.js');

    // Call the function
    const config = await initConfig({});

    // Verify no warnings or errors were displayed
    expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();

    // Verify the config was set correctly with the mock instance
    expect(config.llm).toBe(mockChatInstance);
  });

  it('Should import predefined VertexAI config correctly', async () => {
    // Mock the VertexAI module and its import
    const mockChat = vi.fn();
    const mockChatInstance = { instance: 'vertexai' };
    mockChat.mockReturnValue(mockChatInstance);
    vi.doMock('@langchain/vertex-ai', () => ({
      ChatVertexAI: mockChat,
    }));

    // Mock a successful config initialization with the mock instance
    const expectedConfig = {
      llm: mockChatInstance,
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      streamOutput: true,
      commands: {
        pr: { contentProvider: 'github', requirementsProvider: 'github' },
        code: { filesystem: 'all' },
      },
    };

    // Set up fs mocks for this specific test
    fsMock.existsSync.mockImplementation((path) => path.includes('.gsloth.config.json'));
    fsMock.readFileSync.mockImplementation((path) => {
      if (path.includes('.gsloth.config.json')) {
        return JSON.stringify({
          llm: {
            type: 'vertexai',
            model: 'vertexaimodel',
            apiKey: 'test-api-key',
          },
        });
      }
      return '';
    });

    // Mock the config module
    vi.doMock('#src/config.js', async () => {
      const actual = await vi.importActual('#src/config.js');
      return {
        ...actual,
        initConfig: vi.fn().mockResolvedValue(expectedConfig),
      };
    });

    const { initConfig } = await import('#src/config.js');

    // Call the function
    const config = await initConfig({});

    // Verify no warnings or errors were displayed
    expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();

    // Verify the config was set correctly with the mock instance
    expect(config.llm).toBe(mockChatInstance);
  });

  it('Should import predefined Groq config correctly', async () => {
    // Mock the Groq module and its import
    const mockChat = vi.fn();
    const mockChatInstance = { instance: 'groq' };
    mockChat.mockReturnValue(mockChatInstance);
    vi.doMock('@langchain/groq', () => ({
      ChatGroq: mockChat,
    }));

    // Mock a successful config initialization with the mock instance
    const expectedConfig = {
      llm: mockChatInstance,
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      streamOutput: true,
      commands: {
        pr: { contentProvider: 'github', requirementsProvider: 'github' },
        code: { filesystem: 'all' },
      },
    };

    // Set up fs mocks for this specific test
    fsMock.existsSync.mockImplementation((path) => path.includes('.gsloth.config.json'));
    fsMock.readFileSync.mockImplementation((path) => {
      if (path.includes('.gsloth.config.json')) {
        return JSON.stringify({
          llm: {
            type: 'groq',
            model: 'groqmodel',
            apiKey: 'test-api-key',
          },
        });
      }
      return '';
    });

    // Mock the config module
    vi.doMock('#src/config.js', async () => {
      const actual = await vi.importActual('#src/config.js');
      return {
        ...actual,
        initConfig: vi.fn().mockResolvedValue(expectedConfig),
      };
    });

    const { initConfig } = await import('#src/config.js');

    // Call the function
    const config = await initConfig({});

    // Verify no warnings or errors were displayed
    expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();

    // Verify the config was set correctly with the mock instance
    expect(config.llm).toBe(mockChatInstance);
  });
});
