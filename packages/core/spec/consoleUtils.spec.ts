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
  error: vi.fn(),
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

    describe('displayToolIndication (TUI-C30)', () => {
      it('prints the pre-styled block verbatim (no extra colour wrap) and logs it stripped', async () => {
        systemUtilsMock.getUseColour.mockReturnValue(true); // must NOT trigger a dim wrap
        const { displayToolIndication } = await import('#src/utils/consoleUtils.js');

        const block = '\n✓ read_file(path=a.txt)\n    \x1b[2mline-1\x1b[0m';
        displayToolIndication(block);

        // Verbatim to the console — the block styles its own lines; an outer dim wrap would be
        // broken by the inner resets.
        expect(systemUtilsMock.info).toHaveBeenCalledWith(block);
        // The session log gets the ANSI-stripped text.
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(
          '\n✓ read_file(path=a.txt)\n    line-1\n'
        );
      });

      it('is gated at INFO level like the historical tool notices', async () => {
        const { displayToolIndication, setConsoleLevel } =
          await import('#src/utils/consoleUtils.js');
        setConsoleLevel(StatusLevel.WARNING);

        displayToolIndication('✓ read_file(path=a.txt)');

        expect(systemUtilsMock.info).not.toHaveBeenCalled();
        expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();
      });
    });

    describe('displayLaunchBanner (TUI-C33)', () => {
      it('prints the pre-styled banner verbatim and keeps it OUT of the session log', async () => {
        systemUtilsMock.getUseColour.mockReturnValue(true); // must NOT trigger an outer colour wrap
        const { displayLaunchBanner } = await import('#src/utils/consoleUtils.js');

        // The block colours its own face halves; the right column is deliberately bare.
        const banner = '\x1b[35m  ▄█▀▀▀▀▀▀▀▀█▄     \x1b[0m┏┓         ┏┓┓   ┓';
        displayLaunchBanner(banner);

        // stdout channel, verbatim — an outer wrap would be broken by the inner resets.
        expect(systemUtilsMock.log).toHaveBeenCalledWith(banner);
        // Requirement 6: the session log is a transcript of the conversation, not a screenshot of
        // the screen. Session logging is ENABLED in this block (see the outer beforeEach), so a
        // reinstated writeToSessionLog call would be caught here.
        expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();
      });

      it('is gated at DISPLAY level like the plain display() it shares a channel with', async () => {
        const { displayLaunchBanner, setConsoleLevel } = await import('#src/utils/consoleUtils.js');
        setConsoleLevel(StatusLevel.SUCCESS); // one step above DISPLAY

        displayLaunchBanner('  ▀██████████▀');

        expect(systemUtilsMock.log).not.toHaveBeenCalled();
        expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();
      });
    });

    /**
     * [[EXT-105]] — `displayDialogLine` is the only `display*` helper in this file WITHOUT a
     * `shouldDisplayLevel` guard, and that omission is not an oversight: it is the fix.
     *
     * The level filter is per line, so a gated dialog prints the parts above the threshold and
     * drops the rest — which is how an approval prompt comes to show a severity heading with no
     * command under it and still look complete. A later pass making the nine helpers uniform would
     * restore exactly that, in good faith, on a security path. These cells are what stops it.
     */
    describe('displayDialogLine (EXT-105) — deliberately not level-gated', () => {
      /**
       * ERROR and STREAM, not one of them: a reinstated guard would most likely be written at
       * DISPLAY level, which is silent at both — but a guard written at ERROR would still print at
       * ERROR, and only STREAM catches that one. The pair covers every threshold anyone would
       * plausibly add.
       */
      it.each([
        ['error', StatusLevel.ERROR],
        ['stream', StatusLevel.STREAM],
      ])(
        'prints the whole dialog at consoleLevel %s, where a gated helper is silent',
        async (_name, level) => {
          const { displayDialogLine, display, setConsoleLevel } =
            await import('#src/utils/consoleUtils.js');
          setConsoleLevel(level);

          // The CONTROL, and it is load-bearing: without it this cell would still pass if
          // `setConsoleLevel` had quietly done nothing, which is the shape of an assertion that
          // cannot fail. `display` is the helper the framed command used to go through.
          display('the framed command, through the gated helper');
          expect(systemUtilsMock.log).not.toHaveBeenCalled();

          // The two lines whose separation is the defect: a heading is useless without the command
          // it is about, so the writer must not be able to emit one and drop the other.
          displayDialogLine('⚠ Auto-rater (destructive): this can destroy work or data.', 'warn');
          displayDialogLine('  1 │ rm -rf build');

          expect(systemUtilsMock.error).toHaveBeenCalledTimes(2);
          expect(systemUtilsMock.error).toHaveBeenNthCalledWith(
            1,
            '⚠ Auto-rater (destructive): this can destroy work or data.'
          );
          expect(systemUtilsMock.error).toHaveBeenNthCalledWith(2, '  1 │ rm -rf build');

          // ...and the session log keeps the whole dialog. The gated helpers put their log write
          // BEHIND the guard, so a quieted console dropped those lines from the transcript too.
          expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledTimes(2);
          expect(systemUtilsMock.writeToLogStream).toHaveBeenNthCalledWith(
            2,
            '  1 │ rm -rf build\n'
          );
        }
      );
    });

    /**
     * [[EXT-165]] — `displayNotice` takes a notice's title and its body TOGETHER, so the level
     * filter applies to the notice rather than to each line of it.
     *
     * Per line is what the two renderers used to get, and it fails in both directions: at
     * `consoleLevel: warning` a notice printed its warn-toned title with the body filtered out from
     * under it, and at `consoleLevel: display` an info notice printed its body with the title
     * filtered out from over it. Half a notice still looks like a whole one, which is why the
     * decision is taken once here, before the first line is written.
     *
     * Which DESCRIPTOR the lines land on is asserted in
     * `packages/core/spec/noticeStreamProcess.e2e.spec.ts`: these mocks stand exactly where the
     * stream mapping is, so they cannot see it.
     */
    describe('displayNotice (EXT-165) — the gate is per notice, never per line', () => {
      it('writes the whole notice through one stream writer, title marked by tone', async () => {
        const { displayNotice } = await import('#src/utils/consoleUtils.js');

        displayNotice('Approvals posture', ['Mode: write', 'Refusals: 1'], { tone: 'warn' });

        // One writer for every line: `error` is the stderr-side primitive `displayDialogLine`
        // already uses, and nothing went to the stdout-side ones.
        expect(systemUtilsMock.error).toHaveBeenCalledTimes(3);
        expect(systemUtilsMock.error).toHaveBeenNthCalledWith(1, '⚠ Approvals posture');
        expect(systemUtilsMock.error).toHaveBeenNthCalledWith(2, '  Mode: write');
        expect(systemUtilsMock.error).toHaveBeenNthCalledWith(3, '  Refusals: 1');
        expect(systemUtilsMock.log).not.toHaveBeenCalled();
        expect(systemUtilsMock.info).not.toHaveBeenCalled();
        expect(systemUtilsMock.warn).not.toHaveBeenCalled();
      });

      /**
       * The tone in the TEXT, with colour off. `getUseColour` is false throughout this file, so a
       * marker that lived only in the ANSI wrapper would leave these two titles identical in shape
       * — which is the monochrome reader's experience of a colour-only severity.
       */
      it('marks a warn title and leaves an info one unmarked, with no colour applied', async () => {
        const { displayNotice } = await import('#src/utils/consoleUtils.js');

        displayNotice('Same Words', ['body'], { tone: 'warn' });
        displayNotice('Same Words', ['body'], { tone: 'info' });

        const titles = systemUtilsMock.error.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('Same Words'));
        expect(titles).toEqual(['⚠ Same Words', 'Same Words']);
        expect(titles[0]).not.toBe(titles[1]);
      });

      it.each([
        ['warning', StatusLevel.WARNING],
        ['error', StatusLevel.ERROR],
      ])(
        'drops an info notice ENTIRELY at consoleLevel %s — neither title nor body',
        async (_name, level) => {
          const { displayNotice, display, setConsoleLevel } =
            await import('#src/utils/consoleUtils.js');
          setConsoleLevel(level);

          displayNotice('Session status', ['Mode: code'], { tone: 'info' });
          expect(systemUtilsMock.error).not.toHaveBeenCalled();

          // CONTROL for the OTHER direction, and it is load-bearing: the body lines used to go
          // through `display`, whose DISPLAY-level gate is open at neither of these levels. This
          // proves the level actually took effect rather than the call having silently done
          // nothing.
          display('the body line, through the gated helper');
          expect(systemUtilsMock.log).not.toHaveBeenCalled();
        }
      );

      /**
       * The mirror trap, and the one neither renderer's author saw: `display` is open at DISPLAY
       * level while `displayInfo` is not, so an info notice used to print its BODY with no title
       * over it. The control here is the inverse of the one above — `display` must be heard, or
       * this cell would pass on a console that was silent for an unrelated reason.
       */
      it('drops an info notice entirely at consoleLevel display, where its body used to print alone', async () => {
        const { displayNotice, display, setConsoleLevel } =
          await import('#src/utils/consoleUtils.js');
        setConsoleLevel(StatusLevel.DISPLAY);

        display('CONTROL: the gated helper is audible at this level');
        expect(systemUtilsMock.log).toHaveBeenCalledWith(
          'CONTROL: the gated helper is audible at this level'
        );

        displayNotice('Session status', ['Mode: code'], { tone: 'info' });
        expect(systemUtilsMock.error).not.toHaveBeenCalled();
      });

      it('keeps a warn notice WHOLE at consoleLevel warning, where its body used to be dropped', async () => {
        const { displayNotice, display, setConsoleLevel } =
          await import('#src/utils/consoleUtils.js');
        setConsoleLevel(StatusLevel.WARNING);

        // CONTROL: the helper the body used to travel through is silent here — which is exactly
        // how a title arrived with nothing under it.
        display('the body line, through the gated helper');
        expect(systemUtilsMock.log).not.toHaveBeenCalled();

        displayNotice('Run ended: the provider failed', ['Reason code: provider_error@site'], {
          tone: 'warn',
        });
        expect(systemUtilsMock.error).toHaveBeenCalledTimes(2);
        expect(systemUtilsMock.error).toHaveBeenNthCalledWith(
          2,
          '  Reason code: provider_error@site'
        );
      });

      /**
       * `gate: 'always'` — the termination notice's setting, pinned at TWO levels for the reason
       * [[EXT-105]] recorded: a guard reinstated at DISPLAY level is silent at both, but one
       * reinstated at ERROR level still prints at ERROR, and only STREAM catches that one. One
       * level would leave a plausible mutation alive.
       */
      it.each([
        ['error', StatusLevel.ERROR],
        ['stream', StatusLevel.STREAM],
      ])('delivers an always-gated notice whole at consoleLevel %s', async (_name, level) => {
        const { displayNotice, display, setConsoleLevel } =
          await import('#src/utils/consoleUtils.js');
        setConsoleLevel(level);

        display('the body line, through the gated helper');
        expect(systemUtilsMock.log).not.toHaveBeenCalled();

        displayNotice('Run ended: the provider failed', ['Reason code: provider_error@site'], {
          tone: 'warn',
          gate: 'always',
        });
        expect(systemUtilsMock.error).toHaveBeenCalledTimes(2);
        expect(systemUtilsMock.error).toHaveBeenNthCalledWith(
          1,
          '⚠ Run ended: the provider failed'
        );
        expect(systemUtilsMock.error).toHaveBeenNthCalledWith(
          2,
          '  Reason code: provider_error@site'
        );
      });

      /**
       * The session log keeps the whole notice whether or not the console showed it — the same
       * unconditional write `displayDialogLine` makes, for the same reason: the gated helpers put
       * their log write BEHIND the guard, so a quieted console cost the transcript the lines too.
       */
      it('records a silenced notice in the session log in full', async () => {
        const { displayNotice, setConsoleLevel } = await import('#src/utils/consoleUtils.js');
        setConsoleLevel(StatusLevel.ERROR);

        displayNotice('Session status', ['Mode: code'], { tone: 'info' });

        expect(systemUtilsMock.error).not.toHaveBeenCalled();
        expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledTimes(2);
        expect(systemUtilsMock.writeToLogStream).toHaveBeenNthCalledWith(1, 'Session status\n');
        expect(systemUtilsMock.writeToLogStream).toHaveBeenNthCalledWith(2, '  Mode: code\n');
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
