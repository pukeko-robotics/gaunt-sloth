import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';

// Mock the systemUtils module
const systemUtilsMock = {
  getUseColour: vi.fn(),
  initLogStream: vi.fn(),
  writeToLogStream: vi.fn(),
  closeLogStream: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  stream: vi.fn(),
};

// Mock the debugUtils module
const debugUtilsMock = {
  debugLog: vi.fn(),
};

vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);
vi.mock('#src/utils/debugUtils.js', () => debugUtilsMock);

describe('consoleUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.getUseColour.mockReturnValue(false); // Default to no colors for easier testing
  });

  describe('console level control', () => {
    afterEach(async () => {
      // Reset console level after each test
      const { resetConsoleLevel } = await import('#src/utils/consoleUtils.js');
      resetConsoleLevel();
    });

    it('should set and get console level', async () => {
      const { setConsoleLevel, getConsoleLevel } = await import('#src/utils/consoleUtils.js');

      // Default should be INFO
      expect(getConsoleLevel()).toBe(StatusLevel.INFO);

      // Set to DEBUG
      setConsoleLevel(StatusLevel.DEBUG);
      expect(getConsoleLevel()).toBe(StatusLevel.DEBUG);

      // Set to ERROR
      setConsoleLevel(StatusLevel.ERROR);
      expect(getConsoleLevel()).toBe(StatusLevel.ERROR);
    });

    it('should display messages at or above current level', async () => {
      const {
        setConsoleLevel,
        displayInfo,
        displayWarning,
        displayError,
        displaySuccess,
        display,
        displayDebug,
      } = await import('#src/utils/consoleUtils.js');

      // Set level to WARNING
      setConsoleLevel(StatusLevel.WARNING);

      // Should display WARNING and ERROR
      displayWarning('Warning message');
      displayError('Error message');
      expect(systemUtilsMock.warn).toHaveBeenCalledWith('Warning message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Error message');

      // Should NOT display INFO, SUCCESS, DISPLAY, or DEBUG
      displayInfo('Info message');
      displaySuccess('Success message');
      display('Display message');
      displayDebug('Debug message');
      expect(systemUtilsMock.info).not.toHaveBeenCalled();
      // Note: displaySuccess and display both call log(), so we need to be more specific
      expect(systemUtilsMock.log).toHaveBeenCalledTimes(1); // Only error message
      expect(systemUtilsMock.warn).toHaveBeenCalledTimes(1); // Only warning message
      expect(systemUtilsMock.debug).not.toHaveBeenCalled();
    });

    it('should display all messages when level is DEBUG', async () => {
      const {
        setConsoleLevel,
        displayInfo,
        displayWarning,
        displayError,
        displaySuccess,
        display,
        displayDebug,
      } = await import('#src/utils/consoleUtils.js');

      // Set level to DEBUG (lowest level)
      setConsoleLevel(StatusLevel.DEBUG);

      // Should display all levels
      displayDebug('Debug message');
      displayInfo('Info message');
      display('Display message');
      displaySuccess('Success message');
      displayWarning('Warning message');
      displayError('Error message');

      expect(systemUtilsMock.debug).toHaveBeenCalledWith('Debug message');
      expect(systemUtilsMock.info).toHaveBeenCalledWith('Info message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Success message');
      expect(systemUtilsMock.warn).toHaveBeenCalledWith('Warning message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Error message');
    });

    it('should display no messages when level is higher than available', async () => {
      const {
        setConsoleLevel,
        displayInfo,
        displayWarning,
        displayError,
        displaySuccess,
        display,
        displayDebug,
      } = await import('#src/utils/consoleUtils.js');

      // Set level to STREAM (highest level)
      setConsoleLevel(StatusLevel.STREAM);

      // Should NOT display any regular messages
      displayDebug('Debug message');
      displayInfo('Info message');
      display('Display message');
      displaySuccess('Success message');
      displayWarning('Warning message');
      displayError('Error message');

      // None of the display functions should be called since STREAM is highest level
      expect(systemUtilsMock.debug).not.toHaveBeenCalled();
      expect(systemUtilsMock.info).not.toHaveBeenCalled();
      expect(systemUtilsMock.log).not.toHaveBeenCalled();
      expect(systemUtilsMock.warn).not.toHaveBeenCalled();
      expect(systemUtilsMock.stream).not.toHaveBeenCalled();
    });
  });

  describe('initSessionLogging', () => {
    it('should initialize session logging when enabled', async () => {
      // Import the function after mocks are set up
      const { initSessionLogging } = await import('#src/utils/consoleUtils.js');

      const logFileName = 'test-session.log';

      // Act
      initSessionLogging(logFileName, true);

      // Assert
      expect(systemUtilsMock.initLogStream).toHaveBeenCalledWith(logFileName);
    });

    it('should not initialize session logging when disabled', async () => {
      // Import the function after mocks are set up
      const { initSessionLogging } = await import('#src/utils/consoleUtils.js');

      const logFileName = 'test-session.log';

      // Act
      initSessionLogging(logFileName, false);

      // Assert
      expect(systemUtilsMock.initLogStream).not.toHaveBeenCalled();
    });
  });

  describe('stopSessionLogging', () => {
    it('should close log stream and reset state', async () => {
      // Import the functions after mocks are set up
      const { initSessionLogging, stopSessionLogging } = await import('#src/utils/consoleUtils.js');

      // Set up session logging first
      initSessionLogging('test.log', true);

      // Act
      stopSessionLogging();

      // Assert
      expect(systemUtilsMock.closeLogStream).toHaveBeenCalled();
    });
  });

  describe('display functions', () => {
    beforeEach(async () => {
      // Import and initialize session logging for each test
      const { initSessionLogging, setConsoleLevel } = await import('#src/utils/consoleUtils.js');
      initSessionLogging('test.log', true);
      // Set console level to always show all messages during tests
      setConsoleLevel(StatusLevel.DEBUG);
    });

    afterEach(async () => {
      // Reset console level after each test
      const { resetConsoleLevel } = await import('#src/utils/consoleUtils.js');
      resetConsoleLevel();
    });

    describe('displayError', () => {
      it('should display error message and log to session', async () => {
        // Import the function after mocks are set up
        const { displayError } = await import('#src/utils/consoleUtils.js');

        const message = 'Test error message';

        // Act
        displayError(message);

        // Assert
        expect(systemUtilsMock.log).toHaveBeenCalledWith(message); // Without colors
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
      });

      it('should display colored error when colors enabled', async () => {
        systemUtilsMock.getUseColour.mockReturnValue(true);

        // Import the function after mocks are set up
        const { displayError } = await import('#src/utils/consoleUtils.js');

        const message = 'Test error message';

        // Act
        displayError(message);

        // Assert
        expect(systemUtilsMock.log).toHaveBeenCalledWith(expect.stringContaining('\x1b[31m')); // Red color
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n'); // Clean message
      });
    });

    describe('displayWarning', () => {
      it('should display warning message and log to session', async () => {
        // Import the function after mocks are set up
        const { displayWarning } = await import('#src/utils/consoleUtils.js');

        const message = 'Test warning message';

        // Act
        displayWarning(message);

        // Assert
        expect(systemUtilsMock.warn).toHaveBeenCalledWith(message);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
      });
    });

    describe('displaySuccess', () => {
      it('should display success message and log to session', async () => {
        // Import the function after mocks are set up
        const { displaySuccess } = await import('#src/utils/consoleUtils.js');

        const message = 'Test success message';

        // Act
        displaySuccess(message);

        // Assert
        expect(systemUtilsMock.log).toHaveBeenCalledWith(message);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
      });
    });

    describe('displayInfo', () => {
      it('should display info message and log to session', async () => {
        // Import the function after mocks are set up
        const { displayInfo } = await import('#src/utils/consoleUtils.js');

        const message = 'Test info message';

        // Act
        displayInfo(message);

        // Assert
        expect(systemUtilsMock.info).toHaveBeenCalledWith(message);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
      });
    });

    describe('display', () => {
      it('should display plain message and log to session', async () => {
        // Import the function after mocks are set up
        const { display } = await import('#src/utils/consoleUtils.js');

        const message = 'Test plain message';

        // Act
        display(message);

        // Assert
        expect(systemUtilsMock.log).toHaveBeenCalledWith(message);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
      });
    });

    describe('displayDebug', () => {
      it('should display debug message and log to session', async () => {
        // Import the function after mocks are set up
        const { displayDebug } = await import('#src/utils/consoleUtils.js');

        const message = 'Test debug message';

        // Act
        displayDebug(message);

        // Assert
        expect(systemUtilsMock.debug).toHaveBeenCalledWith(message);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
        expect(debugUtilsMock.debugLog).toHaveBeenCalledWith(message);
      });

      it('should handle Error objects', async () => {
        // Import the function after mocks are set up
        const { displayDebug } = await import('#src/utils/consoleUtils.js');

        const error = new Error('Test error');
        error.stack = 'Error: Test error\n    at test.js:1:1';

        // Act
        displayDebug(error);

        // Assert
        expect(systemUtilsMock.debug).toHaveBeenCalledWith(error.stack);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(error.stack + '\n');
        expect(debugUtilsMock.debugLog).toHaveBeenCalledWith(error.stack);
      });

      it('should handle undefined values', async () => {
        // Import the function after mocks are set up
        const { displayDebug } = await import('#src/utils/consoleUtils.js');

        // Act
        displayDebug(undefined);

        // Assert
        expect(systemUtilsMock.debug).not.toHaveBeenCalled();
        expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();
        expect(debugUtilsMock.debugLog).not.toHaveBeenCalled();
      });

      it('should not display debug messages when console level is above DEBUG', async () => {
        // Import the functions after mocks are set up
        const { setConsoleLevel, displayDebug } = await import('#src/utils/consoleUtils.js');

        // Set console level to INFO (above DEBUG)
        setConsoleLevel(StatusLevel.INFO);

        const message = 'Test debug message';

        // Act
        displayDebug(message);

        // Assert
        expect(systemUtilsMock.debug).not.toHaveBeenCalled();
        expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();
        expect(debugUtilsMock.debugLog).not.toHaveBeenCalled();
      });

      it('should display debug messages when console level is DEBUG', async () => {
        // Import the functions after mocks are set up
        const { setConsoleLevel, displayDebug } = await import('#src/utils/consoleUtils.js');

        // Set console level to DEBUG
        setConsoleLevel(StatusLevel.DEBUG);

        const message = 'Test debug message';

        // Act
        displayDebug(message);

        // Assert
        expect(systemUtilsMock.debug).toHaveBeenCalledWith(message);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(message + '\n');
        expect(debugUtilsMock.debugLog).toHaveBeenCalledWith(message);
      });
    });
  });

  describe('defaultStatusCallback', () => {
    beforeEach(async () => {
      // Import and initialize session logging for each test
      const { initSessionLogging, setConsoleLevel } = await import('#src/utils/consoleUtils.js');
      initSessionLogging('test.log', true);
      // Set console level to show all messages
      setConsoleLevel(StatusLevel.DEBUG);
    });

    afterEach(async () => {
      // Reset console level after each test
      const { resetConsoleLevel } = await import('#src/utils/consoleUtils.js');
      resetConsoleLevel();
    });

    it('should handle all status levels correctly', async () => {
      // Import the callback after mocks are set up
      const { defaultStatusCallback } = await import('#src/utils/consoleUtils.js');

      // Test info level
      defaultStatusCallback(StatusLevel.INFO, 'Info message');
      expect(systemUtilsMock.info).toHaveBeenCalledWith('Info message');

      // Test warning level
      defaultStatusCallback(StatusLevel.WARNING, 'Warning message');
      expect(systemUtilsMock.warn).toHaveBeenCalledWith('Warning message');

      // Test error level
      defaultStatusCallback(StatusLevel.ERROR, 'Error message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Error message');

      // Test success level
      defaultStatusCallback(StatusLevel.SUCCESS, 'Success message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Success message');

      // Test debug level
      defaultStatusCallback(StatusLevel.DEBUG, 'Debug message');
      expect(systemUtilsMock.debug).toHaveBeenCalledWith('Debug message');

      // Test display level
      defaultStatusCallback(StatusLevel.DISPLAY, 'Display message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Display message');

      // Test stream level
      defaultStatusCallback(StatusLevel.STREAM, 'Stream message');
      expect(systemUtilsMock.stream).toHaveBeenCalledWith('Stream message');
      expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith('Stream message');
    });

    it('should respect console level in status callback', async () => {
      // Import the callback after mocks are set up
      const { defaultStatusCallback, setConsoleLevel } = await import('#src/utils/consoleUtils.js');

      // Set console level to WARNING
      setConsoleLevel(StatusLevel.WARNING);

      // Should display WARNING and ERROR
      defaultStatusCallback(StatusLevel.WARNING, 'Warning message');
      defaultStatusCallback(StatusLevel.ERROR, 'Error message');
      expect(systemUtilsMock.warn).toHaveBeenCalledWith('Warning message');
      expect(systemUtilsMock.log).toHaveBeenCalledWith('Error message');

      // Should NOT display INFO, SUCCESS, DISPLAY, or DEBUG
      defaultStatusCallback(StatusLevel.INFO, 'Info message');
      defaultStatusCallback(StatusLevel.SUCCESS, 'Success message');
      defaultStatusCallback(StatusLevel.DISPLAY, 'Display message');
      defaultStatusCallback(StatusLevel.DEBUG, 'Debug message');
      expect(systemUtilsMock.info).not.toHaveBeenCalled();
      expect(systemUtilsMock.log).toHaveBeenCalledTimes(1); // Only error message
      expect(systemUtilsMock.warn).toHaveBeenCalledTimes(1); // Only warning message
      expect(systemUtilsMock.debug).not.toHaveBeenCalled();
    });
  });

  describe('formatInputPrompt', () => {
    it('should format input prompt without colors when disabled', async () => {
      systemUtilsMock.getUseColour.mockReturnValue(false);

      // Import the function after mocks are set up
      const { formatInputPrompt } = await import('#src/utils/consoleUtils.js');

      const message = 'Enter input:';

      // Act
      const result = formatInputPrompt(message);

      // Assert
      expect(result).toBe(message);
    });

    it('should format input prompt with colors when enabled', async () => {
      systemUtilsMock.getUseColour.mockReturnValue(true);

      // Import the function after mocks are set up
      const { formatInputPrompt } = await import('#src/utils/consoleUtils.js');

      const message = 'Enter input:';

      // Act
      const result = formatInputPrompt(message);

      // Assert
      expect(result).toContain('\x1b[35m'); // Magenta color
      expect(result).toContain('\x1b[0m'); // Reset color
      expect(result).toContain(message);
    });
  });

  describe('session logging with disabled state', () => {
    beforeEach(async () => {
      // Set console level to show messages
      const { setConsoleLevel } = await import('#src/utils/consoleUtils.js');
      setConsoleLevel(StatusLevel.DEBUG);
    });

    afterEach(async () => {
      // Reset console level after each test
      const { resetConsoleLevel } = await import('#src/utils/consoleUtils.js');
      resetConsoleLevel();
    });

    it('should not log to session when logging is disabled', async () => {
      // Import the functions after mocks are set up
      const { initSessionLogging, displayInfo } = await import('#src/utils/consoleUtils.js');

      // Initialize with logging disabled
      initSessionLogging('test.log', false);

      const message = 'Test message';

      // Act
      displayInfo(message);

      // Assert
      expect(systemUtilsMock.info).toHaveBeenCalledWith(message);
      expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();
    });
  });

  describe('parseBooleanOrString', () => {
    it('parses false-like tokens', async () => {
      const { parseBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(parseBooleanOrString('false')).toEqual({ kind: 'boolean', value: false });
      expect(parseBooleanOrString('False')).toEqual({ kind: 'boolean', value: false });
      expect(parseBooleanOrString('0')).toEqual({ kind: 'boolean', value: false });
      expect(parseBooleanOrString('n')).toEqual({ kind: 'boolean', value: false });
      expect(parseBooleanOrString('NO')).toEqual({ kind: 'boolean', value: false });
    });

    it('parses true-like tokens', async () => {
      const { parseBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(parseBooleanOrString('true')).toEqual({ kind: 'boolean', value: true });
      expect(parseBooleanOrString('True')).toEqual({ kind: 'boolean', value: true });
      expect(parseBooleanOrString('1')).toEqual({ kind: 'boolean', value: true });
      expect(parseBooleanOrString('y')).toEqual({ kind: 'boolean', value: true });
      expect(parseBooleanOrString('YES')).toEqual({ kind: 'boolean', value: true });
    });

    it('returns string for non-boolean tokens', async () => {
      const { parseBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(parseBooleanOrString('review.md')).toEqual({ kind: 'string', value: 'review.md' });
      expect(parseBooleanOrString('out/rev.md')).toEqual({ kind: 'string', value: 'out/rev.md' });
      // literal string, not a special token
      expect(parseBooleanOrString(' -w0 ')).toEqual({ kind: 'string', value: '-w0' });
    });

    it('returns none for nullish or empty input', async () => {
      const { parseBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(parseBooleanOrString(undefined)).toEqual({ kind: 'none' });
      expect(parseBooleanOrString(null)).toEqual({ kind: 'none' });
      expect(parseBooleanOrString('')).toEqual({ kind: 'none' });
      expect(parseBooleanOrString('   ')).toEqual({ kind: 'none' });
    });
  });

  describe('coerceBooleanOrString', () => {
    it('coerces to boolean for boolean-like tokens', async () => {
      const { coerceBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(coerceBooleanOrString('false')).toBe(false);
      expect(coerceBooleanOrString('0')).toBe(false);
      expect(coerceBooleanOrString('n')).toBe(false);
      expect(coerceBooleanOrString('true')).toBe(true);
      expect(coerceBooleanOrString('1')).toBe(true);
      expect(coerceBooleanOrString('y')).toBe(true);
    });

    it('coerces to string for other values', async () => {
      const { coerceBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(coerceBooleanOrString('review.md')).toBe('review.md');
      expect(coerceBooleanOrString('out/rev.md')).toBe('out/rev.md');
      expect(coerceBooleanOrString(' -wn ')).toBe('-wn');
    });

    it('returns undefined for none', async () => {
      const { coerceBooleanOrString } = await import('#src/utils/consoleUtils.js');
      expect(coerceBooleanOrString(undefined)).toBeUndefined();
      expect(coerceBooleanOrString(null)).toBeUndefined();
      expect(coerceBooleanOrString('   ')).toBeUndefined();
    });
  });

  // TUI-C19 — the warning-capture window the TUI uses to thread transient load-time advisories
  // (config-validation warnings) into its persistent notice surface.
  describe('warning capture (TUI-C19)', () => {
    afterEach(async () => {
      // Always close any open window so a test can't leak capture state into the next.
      const { endWarningCapture } = await import('#src/utils/consoleUtils.js');
      endWarningCapture();
    });

    it('collects displayWarning messages emitted inside a begin/end window', async () => {
      const { beginWarningCapture, endWarningCapture, displayWarning } =
        await import('#src/utils/consoleUtils.js');
      beginWarningCapture();
      displayWarning('Unknown top-level config key: pullrequest. Check for typos.');
      displayWarning('Deprecated config key `pr`; use `commands.pr`.');
      const captured = endWarningCapture();
      expect(captured).toEqual([
        'Unknown top-level config key: pullrequest. Check for typos.',
        'Deprecated config key `pr`; use `commands.pr`.',
      ]);
      // Still printed transiently as before (capture is IN ADDITION, not instead).
      expect(systemUtilsMock.warn).toHaveBeenCalledTimes(2);
    });

    it('returns an empty list for a clean window (no warnings)', async () => {
      const { beginWarningCapture, endWarningCapture } = await import('#src/utils/consoleUtils.js');
      beginWarningCapture();
      expect(endWarningCapture()).toEqual([]);
    });

    it('does not collect warnings emitted outside a window (default = off)', async () => {
      const { displayWarning, endWarningCapture } = await import('#src/utils/consoleUtils.js');
      displayWarning('a warning with no capture window open');
      expect(endWarningCapture()).toEqual([]);
      expect(systemUtilsMock.warn).toHaveBeenCalledTimes(1);
    });
  });
});
