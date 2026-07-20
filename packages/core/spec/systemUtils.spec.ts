import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the process object and its methods
const processMock = {
  stdin: {
    setRawMode: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    isPaused: vi.fn(),
    isTTY: true,
  },
  versions: {
    node: '24.0.0',
  },
};

// Mock console utilities
const consoleUtilsMock = {
  displayWarning: vi.fn(),
  displayInfo: vi.fn(),
};

// Mock fs module
const fsMock = {
  createWriteStream: vi.fn(),
};

const readlineMock = {
  emitKeypressEvents: vi.fn(),
};

// Mock process events
const processEventMocks = {
  on: vi.fn(),
  exit: vi.fn(),
};

// readStdin's blocking-wait path constructs a ProgressIndicator (which writes to stdout); stub it so
// these tests never touch the real terminal.
vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: class {
    indicate() {}
  },
}));

vi.mock('node:fs', () => fsMock);
vi.mock('node:readline', () => readlineMock);
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// Mock the global process object
Object.defineProperty(global, 'process', {
  value: {
    ...processMock,
    ...processEventMocks,
  },
  writable: true,
});

describe('systemUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    processMock.stdin.isPaused.mockReturnValue(false);
  });

  describe('waitForEscape', () => {
    it('should not set up escape handler when disabled', async () => {
      // Import the function after mocks are set up
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      // Act
      waitForEscape(() => {}, false);

      // Assert
      expect(processMock.stdin.setRawMode).not.toHaveBeenCalled();
      expect(processMock.stdin.on).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
    });

    it('should set up escape handler when enabled', async () => {
      // Import the function after mocks are set up
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();

      // Act
      waitForEscape(callback, true);

      // Assert
      expect(readlineMock.emitKeypressEvents).toHaveBeenCalledWith(processMock.stdin);
      expect(processMock.stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(processMock.stdin.resume).toHaveBeenCalled();
      // ref() keeps the handle alive even if a prior stopWaitingForEscape unref()'d it.
      expect(processMock.stdin.ref).toHaveBeenCalled();
      expect(processMock.stdin.on).toHaveBeenCalledWith('keypress', expect.any(Function));
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
        expect.stringContaining('Press Escape or Q to interrupt Agent')
      );
    });

    it('should call callback when escape key is pressed', async () => {
      // Import the function after mocks are set up
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: (_chunk: any, _key: any) => void;

      // Mock stdin.on to capture the keypress handler
      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      // Act
      waitForEscape(callback, true);

      // Simulate escape key press
      keypressHandler!('', { name: 'escape' });

      // Assert
      expect(callback).toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith('\nInterrupting...');
    });

    it('should call callback when Ctrl+C is pressed in raw mode', async () => {
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: (_chunk: any, _key: any) => void;

      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      waitForEscape(callback, true);

      keypressHandler!('\u0003', { name: 'c', ctrl: true });

      expect(callback).toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith('\nInterrupting...');
    });

    it('force-exits on a second Ctrl+C after the first interrupt', async () => {
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: (_chunk: any, _key: any) => void;

      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      waitForEscape(callback, true);

      // First Ctrl+C only interrupts.
      keypressHandler!('', { name: 'c', ctrl: true });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(processEventMocks.exit).not.toHaveBeenCalled();

      // Second Ctrl+C escalates to a hard exit (130 = 128 + SIGINT).
      keypressHandler!('', { name: 'c', ctrl: true });
      expect(processEventMocks.exit).toHaveBeenCalledWith(130);
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        expect.stringContaining('Force exiting')
      );
      // Raw mode is dropped before exiting so a wedged session can't strand the user's terminal.
      expect(processMock.stdin.setRawMode).toHaveBeenCalledWith(false);
    });

    it('force-exits on Ctrl+C after an Escape interrupt', async () => {
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: (_chunk: any, _key: any) => void;

      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      waitForEscape(callback, true);

      // Escape arms the interrupt without exiting.
      keypressHandler!('', { name: 'escape' });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(processEventMocks.exit).not.toHaveBeenCalled();

      // A subsequent Ctrl+C then force-exits.
      keypressHandler!('', { name: 'c', ctrl: true });
      expect(processEventMocks.exit).toHaveBeenCalledWith(130);
    });

    it('does not force-exit when a fresh wait re-arms the interrupt state', async () => {
      const { waitForEscape, stopWaitingForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: (_chunk: any, _key: any) => void;

      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      // First run requests an interrupt.
      waitForEscape(callback, true);
      keypressHandler!('', { name: 'c', ctrl: true });
      stopWaitingForEscape();

      // A new run resets the flag, so the next single Ctrl+C only interrupts.
      waitForEscape(callback, true);
      keypressHandler!('', { name: 'c', ctrl: true });
      expect(processEventMocks.exit).not.toHaveBeenCalled();
    });

    it('should not call callback when other keys are pressed', async () => {
      // Import the function after mocks are set up
      const { waitForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: (_chunk: any, _key: any) => void;

      // Mock stdin.on to capture the keypress handler
      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      // Act
      waitForEscape(callback, true);

      // Simulate other key presses
      keypressHandler!('a', { name: 'a' });
      keypressHandler!('', { name: 'enter' });
      keypressHandler!('', { name: 'space' });

      // Assert
      expect(callback).not.toHaveBeenCalled();
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    });
  });

  describe('stopWaitingForEscape', () => {
    it('should clean up escape handler', async () => {
      // Import the functions after mocks are set up
      const { waitForEscape, stopWaitingForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();
      let keypressHandler: any;

      // Mock stdin.on to capture the keypress handler
      processMock.stdin.on.mockImplementation((event: string, handler: any) => {
        if (event === 'keypress') {
          keypressHandler = handler;
        }
      });

      // Act - set up and then clean up
      waitForEscape(callback, true);
      stopWaitingForEscape();

      // Assert
      expect(processMock.stdin.setRawMode).toHaveBeenCalledWith(false);
      expect(processMock.stdin.off).toHaveBeenCalledWith('keypress', keypressHandler);
    });

    it('should unref stdin during cleanup so the process can exit', async () => {
      const { waitForEscape, stopWaitingForEscape } = await import('#src/utils/systemUtils.js');

      const callback = vi.fn();

      waitForEscape(callback, true);
      stopWaitingForEscape();

      // waitForEscape resumes stdin (refs the handle); stopWaitingForEscape must
      // unref it again, otherwise one-shot commands hang after completion on a TTY.
      expect(processMock.stdin.resume).toHaveBeenCalled();
      expect(processMock.stdin.unref).toHaveBeenCalled();
    });

    it('should not unref stdin when no escape handler is active', async () => {
      const { stopWaitingForEscape } = await import('#src/utils/systemUtils.js');

      stopWaitingForEscape();

      expect(processMock.stdin.unref).not.toHaveBeenCalled();
    });

    it('should handle multiple calls safely', async () => {
      // Import the function after mocks are set up
      const { stopWaitingForEscape } = await import('#src/utils/systemUtils.js');

      // Act - call multiple times
      stopWaitingForEscape();
      stopWaitingForEscape();

      // Assert - should not throw errors
      expect(processMock.stdin.setRawMode).not.toHaveBeenCalled();
      expect(processMock.stdin.off).not.toHaveBeenCalled();
    });
  });

  describe('setRawMode', () => {
    it('should re-ref stdin when entering raw mode so interactive sessions keep prompting', async () => {
      const { setRawMode } = await import('#src/utils/systemUtils.js');

      setRawMode(true);

      // The chat/code loop calls setRawMode(true) before each rl.question(); a prior
      // stopWaitingForEscape() unref'd stdin, so without this re-ref the event loop would
      // drain and the process would exit after the first response (v1.5.5 regression).
      expect(processMock.stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(processMock.stdin.ref).toHaveBeenCalled();
    });

    it('should not ref stdin when disabling raw mode', async () => {
      const { setRawMode } = await import('#src/utils/systemUtils.js');

      setRawMode(false);

      expect(processMock.stdin.setRawMode).toHaveBeenCalledWith(false);
      expect(processMock.stdin.ref).not.toHaveBeenCalled();
    });

    it('should be a no-op when stdin is not a TTY (piped input)', async () => {
      const { setRawMode } = await import('#src/utils/systemUtils.js');

      processMock.stdin.isTTY = false;
      try {
        setRawMode(true);

        expect(processMock.stdin.setRawMode).not.toHaveBeenCalled();
        expect(processMock.stdin.ref).not.toHaveBeenCalled();
      } finally {
        processMock.stdin.isTTY = true;
      }
    });
  });

  describe('log stream functions', () => {
    let mockWriteStream: any;

    beforeEach(() => {
      mockWriteStream = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        destroyed: false,
      };
      fsMock.createWriteStream.mockReturnValue(mockWriteStream);
    });

    describe('initLogStream', () => {
      it('should create a write stream with correct options', async () => {
        // Import the function after mocks are set up
        const { initLogStream } = await import('#src/utils/systemUtils.js');

        const fileName = 'test.log';

        // Act
        initLogStream(fileName);

        // Assert
        expect(fsMock.createWriteStream).toHaveBeenCalledWith(fileName, {
          flags: 'a',
          autoClose: true,
        });
        expect(mockWriteStream.on).toHaveBeenCalledWith('error', expect.any(Function));
        expect(mockWriteStream.on).toHaveBeenCalledWith('close', expect.any(Function));
      });

      it('should handle stream creation errors', async () => {
        // Import the function after mocks are set up
        const { initLogStream } = await import('#src/utils/systemUtils.js');

        const error = new Error('Stream creation failed');
        fsMock.createWriteStream.mockImplementation(() => {
          throw error;
        });

        // Act
        initLogStream('test.log');

        // Assert
        expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
          expect.stringContaining('Failed to create log stream')
        );
      });
    });

    describe('writeToLogStream', () => {
      it('should write to active stream', async () => {
        // Import the functions after mocks are set up
        const { initLogStream, writeToLogStream } = await import('#src/utils/systemUtils.js');

        const message = 'test message';

        // Set up log stream
        initLogStream('test.log');

        // Act
        writeToLogStream(message);

        // Assert
        expect(mockWriteStream.write).toHaveBeenCalledWith(message);
      });

      it('should not write to destroyed stream', async () => {
        // Import the functions after mocks are set up
        const { initLogStream, writeToLogStream } = await import('#src/utils/systemUtils.js');

        const message = 'test message';

        // Set up log stream but mark as destroyed
        initLogStream('test.log');
        mockWriteStream.destroyed = true;

        // Act
        writeToLogStream(message);

        // Assert
        expect(mockWriteStream.write).not.toHaveBeenCalled();
      });
    });

    describe('closeLogStream', () => {
      it('should close active stream', async () => {
        // Import the functions after mocks are set up
        const { initLogStream, closeLogStream } = await import('#src/utils/systemUtils.js');

        // Set up log stream
        initLogStream('test.log');

        // Act
        closeLogStream();

        // Assert
        expect(mockWriteStream.end).toHaveBeenCalled();
      });

      it('should not close destroyed stream', async () => {
        // Import the functions after mocks are set up
        const { initLogStream, closeLogStream } = await import('#src/utils/systemUtils.js');

        // Set up log stream but mark as destroyed
        initLogStream('test.log');
        mockWriteStream.destroyed = true;

        // Act
        closeLogStream();

        // Assert
        expect(mockWriteStream.end).not.toHaveBeenCalled();
      });
    });
  });

  // BATCH-11 (#405 gotcha #5): the fast path (parse immediately, no stdin wait) vs the piped-diff
  // wait path (register readable/end, defer parse until EOF). `eval`/`batch` reach the fast path by
  // having cli.ts imply `nopipe`; `ask`/`review`/`pr` still block-and-read when stdin is piped.
  describe('readStdin', () => {
    const makeProgram = (opts: Record<string, unknown>) => ({
      getOptionValue: (key: string) => opts[key],
      parseAsync: vi.fn().mockResolvedValue(undefined),
    });

    it('takes the fast path (no wait) when nopipe is set, even on a non-TTY — the eval/batch case', async () => {
      processMock.stdin.isTTY = false;
      try {
        const { readStdin } = await import('#src/utils/systemUtils.js');
        const program = makeProgram({ nopipe: true });

        await readStdin(program);

        expect(program.parseAsync).toHaveBeenCalledTimes(1);
        // The blocking wait registers stdin data/EOF listeners — the fast path must not.
        expect(processMock.stdin.on).not.toHaveBeenCalledWith('readable', expect.any(Function));
        expect(processMock.stdin.on).not.toHaveBeenCalledWith('end', expect.any(Function));
      } finally {
        processMock.stdin.isTTY = true;
      }
    });

    it('also takes the fast path when --no-pipe maps pipe to false', async () => {
      processMock.stdin.isTTY = false;
      try {
        const { readStdin } = await import('#src/utils/systemUtils.js');
        const program = makeProgram({ pipe: false });

        await readStdin(program);

        expect(program.parseAsync).toHaveBeenCalledTimes(1);
        expect(processMock.stdin.on).not.toHaveBeenCalledWith('readable', expect.any(Function));
      } finally {
        processMock.stdin.isTTY = true;
      }
    });

    it('takes the fast path on a TTY regardless of pipe options', async () => {
      processMock.stdin.isTTY = true;
      const { readStdin } = await import('#src/utils/systemUtils.js');
      const program = makeProgram({});

      await readStdin(program);

      expect(program.parseAsync).toHaveBeenCalledTimes(1);
      expect(processMock.stdin.on).not.toHaveBeenCalledWith('readable', expect.any(Function));
    });

    it('waits for piped stdin (registers readable/end, defers parse to EOF) — the ask/review case', async () => {
      processMock.stdin.isTTY = false;
      try {
        let endHandler: () => void = () => {};
        processMock.stdin.on.mockImplementation((event: string, handler: () => void) => {
          if (event === 'end') endHandler = handler;
        });

        const { readStdin } = await import('#src/utils/systemUtils.js');
        const program = makeProgram({}); // pipe allowed (no nopipe / pipe !== false)

        const pending = readStdin(program);

        // The blocking wait is set up: it parses only once stdin reaches EOF.
        expect(processMock.stdin.on).toHaveBeenCalledWith('readable', expect.any(Function));
        expect(processMock.stdin.on).toHaveBeenCalledWith('end', expect.any(Function));
        expect(program.parseAsync).not.toHaveBeenCalled();

        // Simulate EOF → now it parses and resolves.
        endHandler();
        await pending;
        expect(program.parseAsync).toHaveBeenCalledTimes(1);
      } finally {
        processMock.stdin.isTTY = true;
      }
    });
  });
});
