import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = {
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const pathMock = {
  dirname: vi.fn(),
  resolve: vi.fn(),
};
vi.mock('node:path', () => pathMock);

describe('debugUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock implementations
    pathMock.resolve.mockImplementation((path: string) => `/resolved/${path}`);
    pathMock.dirname.mockImplementation((path: string) => path.substring(0, path.lastIndexOf('/')));
  });

  describe('initDebugLogging', () => {
    it('should initialize logging when enabled', async () => {
      const { initDebugLogging } = await import('#src/utils/debugUtils.js');

      initDebugLogging(true);

      expect(fsMock.mkdirSync).toHaveBeenCalledWith('/resolved', { recursive: true });
      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining('=== Debug logging initialized ==='),
        'utf8'
      );
    });

    it('should not initialize logging when disabled', async () => {
      const { initDebugLogging } = await import('#src/utils/debugUtils.js');

      initDebugLogging(false);

      expect(fsMock.mkdirSync).not.toHaveBeenCalled();
      expect(fsMock.appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe('debugLog', () => {
    it('should write to log file when debug is enabled', async () => {
      const { initDebugLogging, debugLog } = await import('#src/utils/debugUtils.js');

      initDebugLogging(true);
      vi.clearAllMocks(); // Clear initialization calls

      debugLog('Test message');

      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Test message\n/),
        'utf8'
      );
    });

    it('should not write to log file when debug is disabled', async () => {
      const { initDebugLogging, debugLog } = await import('#src/utils/debugUtils.js');

      initDebugLogging(false);
      debugLog('Test message');

      expect(fsMock.appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe('debugLogMultiline', () => {
    it('should format multiline content with title', async () => {
      const { initDebugLogging, debugLogMultiline } = await import('#src/utils/debugUtils.js');

      initDebugLogging(true);
      vi.clearAllMocks();

      debugLogMultiline('Test Title', 'Line 1\nLine 2');

      expect(fsMock.appendFileSync).toHaveBeenCalledTimes(3);
      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining('=== Test Title ==='),
        'utf8'
      );
      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining('Line 1\nLine 2'),
        'utf8'
      );
    });
  });

  describe('debugLogObject', () => {
    it('should format object using node inspect', async () => {
      const { initDebugLogging, debugLogObject } = await import('#src/utils/debugUtils.js');

      initDebugLogging(true);
      vi.clearAllMocks();

      const testObj = { foo: 'bar', nested: { value: 123 } };
      debugLogObject('Test Object', testObj);

      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining('=== Test Object ==='),
        'utf8'
      );
      // Check that inspect format is used (contains properties without quotes around keys)
      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining("foo: 'bar'"),
        'utf8'
      );
    });
  });

  describe('debugLogError', () => {
    it('should log error with stack trace', async () => {
      const { initDebugLogging, debugLogError } = await import('#src/utils/debugUtils.js');

      initDebugLogging(true);
      vi.clearAllMocks();

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n  at test.js:10:5';
      debugLogError('test context', error);

      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining('❌ Error in test context:'),
        'utf8'
      );
      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        '/resolved/gaunt-sloth.log',
        expect.stringContaining('Message: Test error'),
        'utf8'
      );
    });
  });

  // GS2-46: the in-memory debugLog ring buffer that `/debug-dump` (and later GS2-48's crash
  // handler) reads. It must be populated by every debugLog* variant regardless of whether
  // debugEnabled (the on-disk gate) is on — assertions here are delta-based (buffer length
  // before/after, or unique markers) because the module-level buffer is shared across `it`s
  // within this file (dynamic import resolves the same cached module instance).
  describe('getDebugLogBuffer', () => {
    it('is populated by debugLog even when debug logging is disabled', async () => {
      const { initDebugLogging, debugLog, getDebugLogBuffer } =
        await import('#src/utils/debugUtils.js');

      initDebugLogging(false); // on-disk logging OFF
      const before = getDebugLogBuffer().length;
      debugLog('GS2-46 marker: buffered-without-debugEnabled');
      const after = getDebugLogBuffer();

      expect(fsMock.appendFileSync).not.toHaveBeenCalled();
      expect(after.length).toBe(before + 1);
      expect(after[after.length - 1]).toContain('GS2-46 marker: buffered-without-debugEnabled');
    });

    it('debugLogMultiline, debugLogObject and debugLogError all buffer regardless of debugEnabled', async () => {
      const {
        initDebugLogging,
        debugLogMultiline,
        debugLogObject,
        debugLogError,
        getDebugLogBuffer,
      } = await import('#src/utils/debugUtils.js');

      initDebugLogging(false);
      const before = getDebugLogBuffer().length;

      debugLogMultiline('GS2-46 Multiline', 'body line');
      debugLogObject('GS2-46 Object', { foo: 'bar' });
      debugLogError('GS2-46 context', new Error('boom'));

      const after = getDebugLogBuffer();
      expect(after.length).toBeGreaterThan(before);
      expect(after.some((l) => l.includes('=== GS2-46 Multiline ==='))).toBe(true);
      expect(after.some((l) => l.includes('=== GS2-46 Object ==='))).toBe(true);
      expect(after.some((l) => l.includes("foo: 'bar'"))).toBe(true);
      expect(after.some((l) => l.includes('❌ Error in GS2-46 context:'))).toBe(true);
    });

    it('caps the buffer at 1000 entries, evicting the oldest first', async () => {
      const { initDebugLogging, debugLog, getDebugLogBuffer } =
        await import('#src/utils/debugUtils.js');
      initDebugLogging(false); // independent of test order — this test only cares about the buffer

      for (let i = 0; i < 1005; i++) {
        debugLog(`GS2-46 ring-test entry ${String(i).padStart(5, '0')}`);
      }

      const buffer = getDebugLogBuffer();
      expect(buffer.length).toBeLessThanOrEqual(1000);
      expect(buffer.length).toBe(1000);
      // The most recent entries must have survived the cap.
      expect(buffer[buffer.length - 1]).toContain('GS2-46 ring-test entry 01004');
      // The earliest entries pushed in this test must have been evicted.
      expect(buffer.some((l) => l.includes('GS2-46 ring-test entry 00000'))).toBe(false);
    });

    it('returns a copy — mutating the result does not affect the live buffer', async () => {
      const { debugLog, getDebugLogBuffer } = await import('#src/utils/debugUtils.js');

      debugLog('GS2-46 copy-safety marker');
      const snapshot = getDebugLogBuffer();
      const originalLength = snapshot.length;
      snapshot.push('mutated externally');

      expect(getDebugLogBuffer().length).toBe(originalLength);
    });
  });
});
