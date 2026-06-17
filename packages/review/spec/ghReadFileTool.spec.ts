import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

const execAsyncMock = vi.fn();
const debugLogMock = vi.fn();

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
}));
vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: debugLogMock,
}));

function contentsResponse(text: string): string {
  return JSON.stringify({
    type: 'file',
    encoding: 'base64',
    path: 'src/index.ts',
    content: Buffer.from(text, 'utf8').toString('base64'),
  });
}

describe('ghReadFileTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches and decodes file contents via gh api', async () => {
    execAsyncMock.mockResolvedValue(contentsResponse('hello world'));

    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'src/index.ts',
    });

    expect(execAsyncMock).toHaveBeenCalledWith(
      'gh api /repos/octocat/hello-world/contents/src/index.ts'
    );
    expect(result).toContain('Full contents of octocat/hello-world/src/index.ts:');
    expect(result).toContain('hello world');
  });

  it('passes the ref through as a query parameter', async () => {
    execAsyncMock.mockResolvedValue(contentsResponse('on a branch'));

    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'src/index.ts',
      ref: 'feature/abc',
    });

    expect(execAsyncMock).toHaveBeenCalledWith(
      'gh api /repos/octocat/hello-world/contents/src/index.ts?ref=feature/abc'
    );
    expect(result).toContain('octocat/hello-world/src/index.ts@feature/abc');
    expect(result).toContain('on a branch');
  });

  it('rejects shell metacharacters in path without invoking gh', async () => {
    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'src/index.ts;rm -rf /',
    });

    expect(execAsyncMock).not.toHaveBeenCalled();
    expect(result).toContain('Invalid file path');
  });

  it('rejects parent-directory traversal in path', async () => {
    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({
      owner: 'octocat',
      repo: 'hello-world',
      path: '../../etc/passwd',
    });

    expect(execAsyncMock).not.toHaveBeenCalled();
    expect(result).toContain('Invalid file path');
  });

  it('rejects invalid owner and repo', async () => {
    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');

    const badOwner = await ghReadFileImpl({ owner: 'bad owner', repo: 'r', path: 'a.txt' });
    expect(badOwner).toContain('Invalid repository owner');

    const badRepo = await ghReadFileImpl({ owner: 'octocat', repo: 'bad;repo', path: 'a.txt' });
    expect(badRepo).toContain('Invalid repository name');

    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it('rejects invalid ref', async () => {
    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'a.txt',
      ref: 'main;evil',
    });

    expect(execAsyncMock).not.toHaveBeenCalled();
    expect(result).toContain('Invalid git ref');
  });

  it('gracefully skips when gh fails (no throw)', async () => {
    execAsyncMock.mockRejectedValue(new Error('gh: not authenticated'));

    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({ owner: 'octocat', repo: 'hello-world', path: 'a.txt' });

    expect(result).toContain('Could not read');
    expect(result).toContain('gh: not authenticated');
  });

  it('reports when the response is a directory', async () => {
    execAsyncMock.mockResolvedValue(JSON.stringify([{ type: 'file', name: 'a.txt' }]));

    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({ owner: 'octocat', repo: 'hello-world', path: 'src' });

    expect(result).toContain('is a directory');
  });

  it('reports when content is not inline base64 (e.g. too large)', async () => {
    execAsyncMock.mockResolvedValue(
      JSON.stringify({ type: 'file', encoding: 'none', content: '' })
    );

    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({ owner: 'octocat', repo: 'hello-world', path: 'big.bin' });

    expect(result).toContain('did not return inline base64 content');
  });

  it('handles unparseable JSON gracefully', async () => {
    execAsyncMock.mockResolvedValue('not json');

    const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
    const result = await ghReadFileImpl({ owner: 'octocat', repo: 'hello-world', path: 'a.txt' });

    expect(result).toContain('Failed to parse GitHub API response');
    expect(debugLogMock).toHaveBeenCalled();
  });

  it('exposes a built-in tool via get(config)', async () => {
    const { get, GTH_GH_READ_FILE_TOOL_NAME } = await import('#src/tools/ghReadFileTool.js');
    const tool = get({} as GthConfig);

    expect(tool.name).toBe(GTH_GH_READ_FILE_TOOL_NAME);
    expect(typeof tool.invoke).toBe('function');
  });
});
