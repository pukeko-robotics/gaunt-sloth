import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const fsMock = {
  realpath: vi.fn(),
};

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};

const aiignoreUtilsMock = {
  shouldIgnoreFile: vi.fn(),
};

vi.mock('fs/promises', () => ({ default: fsMock }));
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);
vi.mock('#src/utils/aiignoreUtils.js', () => aiignoreUtilsMock);
vi.mock('#src/tools/binaryUtils.js', async () => {
  const actual = await vi.importActual<typeof import('#src/tools/binaryUtils.js')>(
    '#src/tools/binaryUtils.js'
  );
  return {
    ...actual,
    readBinaryFile: vi.fn(),
  };
});

describe('GthFileSystemToolkit - Binary Tool', () => {
  let GthFileSystemToolkit: typeof import('#src/tools/GthFileSystemToolkit.js').default;
  let readBinaryFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    fsMock.realpath.mockImplementation((p) => Promise.resolve(p));
    aiignoreUtilsMock.shouldIgnoreFile.mockReturnValue(false);

    ({ default: GthFileSystemToolkit } = await import('#src/tools/GthFileSystemToolkit.js'));
    const binaryUtils = await import('#src/tools/binaryUtils.js');
    readBinaryFileMock = binaryUtils.readBinaryFile as unknown as ReturnType<typeof vi.fn>;
  });

  it('should not include gth_read_binary when binaryFormats is not configured', () => {
    const toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
    const toolNames = toolkit.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain('gth_read_binary');
  });

  it('should include gth_read_binary when binaryFormats is configured', () => {
    const toolkit = new GthFileSystemToolkit({
      allowedDirectories: [process.cwd()],
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    });
    const toolNames = toolkit.tools.map((tool) => tool.name);
    expect(toolNames).toContain('gth_read_binary');
  });

  it('gth_read_binary should return an image payload for image formats', async () => {
    readBinaryFileMock.mockResolvedValue({
      data: 'abc',
      size: 3,
      mimeType: 'image/png',
    });

    const toolkit = new GthFileSystemToolkit({
      allowedDirectories: [process.cwd()],
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    });
    const tool = toolkit.tools.find((t) => t.name === 'gth_read_binary')!;
    const filePath = path.join(process.cwd(), 'test.png');

    const result = await tool.invoke({ path: filePath });
    const encodedPath = encodeURIComponent(filePath);
    expect(result).toBe(`gth_read_binary;type:image;path:${encodedPath};data:image/png;base64,abc`);
  });

  it('gth_read_binary should return a binary payload for non-image formats', async () => {
    readBinaryFileMock.mockResolvedValue({
      data: 'def',
      size: 3,
      mimeType: 'audio/mpeg',
    });

    const toolkit = new GthFileSystemToolkit({
      allowedDirectories: [process.cwd()],
      binaryFormats: [{ type: 'audio', extensions: ['mp3'] }],
    });
    const tool = toolkit.tools.find((t) => t.name === 'gth_read_binary')!;
    const filePath = path.join(process.cwd(), 'test.mp3');

    const result = await tool.invoke({ path: filePath, formatHint: 'audio' });
    const encodedPath = encodeURIComponent(filePath);
    expect(result).toBe(
      `gth_read_binary;type:audio;path:${encodedPath};data:audio/mpeg;base64,def`
    );
  });

  it('gth_read_binary should reject unconfigured extensions', async () => {
    const toolkit = new GthFileSystemToolkit({
      allowedDirectories: [process.cwd()],
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    });
    const tool = toolkit.tools.find((t) => t.name === 'gth_read_binary')!;
    const filePath = path.join(process.cwd(), 'test.pdf');

    const result = await tool.invoke({ path: filePath });
    expect(result).toContain("Extension '.pdf' is not configured");
  });

  it('gth_read_binary should reject aiignored paths', async () => {
    aiignoreUtilsMock.shouldIgnoreFile.mockReturnValue(true);

    const toolkit = new GthFileSystemToolkit({
      allowedDirectories: [process.cwd()],
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    });
    const tool = toolkit.tools.find((t) => t.name === 'gth_read_binary')!;
    const filePath = path.join(process.cwd(), 'test.png');

    const result = await tool.invoke({ path: filePath });
    expect(result).toBe('Path is not within allowed directories or is blocked by .aiignore');
  });

  it('gth_read_binary should surface read errors', async () => {
    readBinaryFileMock.mockRejectedValue(new Error('boom'));

    const toolkit = new GthFileSystemToolkit({
      allowedDirectories: [process.cwd()],
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    });
    const tool = toolkit.tools.find((t) => t.name === 'gth_read_binary')!;
    const filePath = path.join(process.cwd(), 'test.png');

    const result = await tool.invoke({ path: filePath });
    expect(result).toContain('Error reading binary file: boom');
  });
});
