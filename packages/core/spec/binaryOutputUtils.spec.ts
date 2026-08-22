import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = {
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const fileUtilsMock = {
  fileSafeLocalDate: vi.fn(),
  getGslothFilePath: vi.fn(),
  toFileSafeString: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

describe('binaryOutputUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    fsMock.existsSync.mockReturnValue(false);
    fileUtilsMock.fileSafeLocalDate.mockReturnValue('2026-03-14_22-18-14');
    fileUtilsMock.getGslothFilePath.mockImplementation((filename: string) => `/tmp/${filename}`);
    fileUtilsMock.toFileSafeString.mockImplementation((value: string) => value);
  });

  it('extractInlineBinaryBlocks should detect Gemini inlineData blocks', async () => {
    const { extractInlineBinaryBlocks } = await import('#src/utils/binaryOutputUtils.js');

    const result = extractInlineBinaryBlocks([
      { type: 'text', text: 'hello' },
      { type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'YWJj' } },
    ]);

    expect(result).toEqual([{ index: 1, mimeType: 'image/png', data: 'YWJj' }]);
  });

  it('extractInlineBinaryBlocks should detect snake_case inline_data, image_url, and source blocks', async () => {
    const { extractInlineBinaryBlocks } = await import('#src/utils/binaryOutputUtils.js');

    const result = extractInlineBinaryBlocks([
      { type: 'inline_data', inline_data: { mime_type: 'image/jpeg', data: 'DEF' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,GHI' } },
      { type: 'image_url', image_url: 'data:image/webp;base64,JKL' },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'MNO' } },
    ]);

    expect(result).toEqual([
      { index: 0, mimeType: 'image/jpeg', data: 'DEF' },
      { index: 1, mimeType: 'image/png', data: 'GHI' },
      { index: 2, mimeType: 'image/webp', data: 'JKL' },
      { index: 3, mimeType: 'image/gif', data: 'MNO' },
    ]);
  });

  it('extractInlineBinaryBlocks should handle single non-array object or string content', async () => {
    const { extractInlineBinaryBlocks } = await import('#src/utils/binaryOutputUtils.js');

    const singleObj = extractInlineBinaryBlocks({
      inlineData: { mimeType: 'image/png', data: 'AAA' },
    });
    expect(singleObj).toEqual([{ index: 0, mimeType: 'image/png', data: 'AAA' }]);

    const singleString = extractInlineBinaryBlocks('data:image/png;base64,BBB');
    expect(singleString).toEqual([{ index: 0, mimeType: 'image/png', data: 'BBB' }]);
  });

  it('materializeBinaryOutputs should write decoded bytes to a gth file path', async () => {
    const { materializeBinaryOutputs } = await import('#src/utils/binaryOutputUtils.js');

    const result = materializeBinaryOutputs(
      [{ type: 'inlineData', inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
      'ask'
    );

    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const [filePath, writtenBuffer] = fsMock.writeFileSync.mock.calls[0];
    expect(filePath).toBe('/tmp/gth_2026-03-14_22-18-14_ASK.png');
    expect(Buffer.from(writtenBuffer).toString('utf8')).toBe('abc');
    expect(result.renderedContent).toContain(
      '[Binary model output saved: image/png -> /tmp/gth_2026-03-14_22-18-14_ASK.png]'
    );
    expect(result.successMessages).toEqual([
      'Wrote model output (image/png) to /tmp/gth_2026-03-14_22-18-14_ASK.png',
    ]);
  });

  it('materializeBinaryOutputs should fall back to bin for unknown mime types', async () => {
    const { materializeBinaryOutputs } = await import('#src/utils/binaryOutputUtils.js');

    const result = materializeBinaryOutputs(
      [{ type: 'inlineData', inlineData: { mimeType: 'application/x-custom', data: 'YWJj' } }],
      'ask'
    );

    expect(result.successMessages).toEqual([
      'Wrote model output (application/x-custom) to /tmp/gth_2026-03-14_22-18-14_ASK.bin',
    ]);
  });
});
