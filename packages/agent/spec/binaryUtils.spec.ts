import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinaryFormatConfig } from '#src/config.js';

const fsPromisesMock = {
  stat: vi.fn(),
  readFile: vi.fn(),
};

vi.mock('node:fs/promises', () => fsPromisesMock);

describe('binaryUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('getFormatForExtension should prefer non-binary matches before binary fallback', async () => {
    const { getFormatForExtension } = await import('#src/tools/binaryUtils.js');
    const configs: BinaryFormatConfig[] = [
      { type: 'image', extensions: ['png', 'jpg'] },
      { type: 'file', extensions: ['pdf'] },
      { type: 'binary', extensions: ['bin', 'png'] },
    ];

    const match = getFormatForExtension('/tmp/test.png', configs);
    expect(match?.type).toBe('image');
  });

  it('getFormatForExtension should fall back to binary when configured', async () => {
    const { getFormatForExtension } = await import('#src/tools/binaryUtils.js');
    const configs: BinaryFormatConfig[] = [
      { type: 'image', extensions: ['png'] },
      { type: 'binary', extensions: ['bin'] },
    ];

    const match = getFormatForExtension('/tmp/test.bin', configs);
    expect(match?.type).toBe('binary');
  });

  it('getFormatForExtension should return null for unknown extensions', async () => {
    const { getFormatForExtension } = await import('#src/tools/binaryUtils.js');
    const configs: BinaryFormatConfig[] = [{ type: 'image', extensions: ['png'] }];

    const match = getFormatForExtension('/tmp/test.unknown', configs);
    expect(match).toBeNull();
  });

  it('getMimeType should prefer overrides', async () => {
    const { getMimeType } = await import('#src/tools/binaryUtils.js');
    const mimeType = getMimeType('heic', {
      type: 'image',
      extensions: ['heic'],
      mimeTypes: { heic: 'image/heic' },
    });

    expect(mimeType).toBe('image/heic');
  });

  it('getMimeType should fall back to defaults and application/octet-stream', async () => {
    const { getMimeType } = await import('#src/tools/binaryUtils.js');

    expect(getMimeType('jpg')).toBe('image/jpeg');
    expect(getMimeType('unknown')).toBe('application/octet-stream');
  });

  it('readBinaryFile should reject files over max size', async () => {
    const { readBinaryFile } = await import('#src/tools/binaryUtils.js');
    fsPromisesMock.stat.mockResolvedValue({ size: 1024 });

    await expect(readBinaryFile('/tmp/test.bin', 512, 'application/octet-stream')).rejects.toThrow(
      'exceeds maximum allowed'
    );
    expect(fsPromisesMock.readFile).not.toHaveBeenCalled();
  });

  it('readBinaryFile should return base64 data', async () => {
    const { readBinaryFile } = await import('#src/tools/binaryUtils.js');
    fsPromisesMock.stat.mockResolvedValue({ size: 5 });
    fsPromisesMock.readFile.mockResolvedValue(Buffer.from('hello'));

    const result = await readBinaryFile('/tmp/test.bin', 1024, 'application/octet-stream');
    expect(result.data).toBe('aGVsbG8=');
    expect(result.size).toBe(5);
    expect(result.mimeType).toBe('application/octet-stream');
  });
});
