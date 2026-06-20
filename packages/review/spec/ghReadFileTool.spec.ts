import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { PrRepoContext } from '#src/tools/ghReadFileTool.js';

const execAsyncMock = vi.fn();
const debugLogMock = vi.fn();

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
}));
vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: debugLogMock,
}));

const CTX: PrRepoContext = { owner: 'octocat', repo: 'hello-world' };

function contentsResponse(text: string): string {
  return JSON.stringify({
    type: 'file',
    encoding: 'base64',
    path: 'src/index.ts',
    content: Buffer.from(text, 'utf8').toString('base64'),
  });
}

function prViewResponse(owner: string, repo: string, headRefName?: string): string {
  return JSON.stringify({
    headRefName,
    headRepository: { name: repo },
    headRepositoryOwner: { login: owner },
  });
}

describe('ghReadFileTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('ghReadFileImpl', () => {
    it('fetches and decodes file contents via gh api', async () => {
      execAsyncMock.mockResolvedValue(contentsResponse('hello world'));

      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'src/index.ts' }, CTX);

      expect(execAsyncMock).toHaveBeenCalledWith(
        'gh api /repos/octocat/hello-world/contents/src/index.ts'
      );
      expect(result).toContain('Full contents of octocat/hello-world/src/index.ts:');
      expect(result).toContain('hello world');
    });

    it('passes the context ref through as a query parameter', async () => {
      execAsyncMock.mockResolvedValue(contentsResponse('on a branch'));

      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'src/index.ts' }, { ...CTX, ref: 'feature/abc' });

      expect(execAsyncMock).toHaveBeenCalledWith(
        'gh api /repos/octocat/hello-world/contents/src/index.ts?ref=feature/abc'
      );
      expect(result).toContain('octocat/hello-world/src/index.ts@feature/abc');
      expect(result).toContain('on a branch');
    });

    it('rejects shell metacharacters in path without invoking gh', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'src/index.ts;rm -rf /' }, CTX);

      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(result).toContain('Invalid file path');
    });

    it('rejects parent-directory traversal in path', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: '../../etc/passwd' }, CTX);

      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(result).toContain('Invalid file path');
    });

    it('rejects invalid owner and repo in the resolved context (defence-in-depth)', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');

      const badOwner = await ghReadFileImpl({ path: 'a.txt' }, { owner: 'bad owner', repo: 'r' });
      expect(badOwner).toContain('Invalid repository owner');

      const badRepo = await ghReadFileImpl(
        { path: 'a.txt' },
        { owner: 'octocat', repo: 'bad;repo' }
      );
      expect(badRepo).toContain('Invalid repository name');

      expect(execAsyncMock).not.toHaveBeenCalled();
    });

    it('rejects invalid ref in the resolved context', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'a.txt' }, { ...CTX, ref: 'main;evil' });

      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(result).toContain('Invalid git ref');
    });

    it('gracefully skips when gh fails (no throw)', async () => {
      execAsyncMock.mockRejectedValue(new Error('gh: not authenticated'));

      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'a.txt' }, CTX);

      expect(result).toContain('Could not read');
      expect(result).toContain('gh: not authenticated');
    });

    it('reports when the response is a directory', async () => {
      execAsyncMock.mockResolvedValue(JSON.stringify([{ type: 'file', name: 'a.txt' }]));

      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'src' }, CTX);

      expect(result).toContain('is a directory');
    });

    it('reports when content is not inline base64 (e.g. too large)', async () => {
      execAsyncMock.mockResolvedValue(
        JSON.stringify({ type: 'file', encoding: 'none', content: '' })
      );

      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'big.bin' }, CTX);

      expect(result).toContain('did not return inline base64 content');
    });

    it('handles unparseable JSON gracefully', async () => {
      execAsyncMock.mockResolvedValue('not json');

      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const result = await ghReadFileImpl({ path: 'a.txt' }, CTX);

      expect(result).toContain('Failed to parse GitHub API response');
      expect(debugLogMock).toHaveBeenCalled();
    });
  });

  describe('resolvePrRepoContext', () => {
    it('resolves owner/repo/ref from gh pr view for an explicit PR id', async () => {
      execAsyncMock.mockResolvedValue(
        prViewResponse('Galvanized-Pukeko', 'gaunt-sloth-assistant', 'feature/rel-2')
      );

      const { resolvePrRepoContext } = await import('#src/tools/ghReadFileTool.js');
      const ctx = await resolvePrRepoContext('368');

      expect(execAsyncMock).toHaveBeenCalledWith(
        'gh pr view 368 --json headRefName,headRepository,headRepositoryOwner'
      );
      expect(ctx).toEqual({
        owner: 'Galvanized-Pukeko',
        repo: 'gaunt-sloth-assistant',
        ref: 'feature/rel-2',
      });
    });

    it('resolves the current branch PR when prId is undefined (discovery mode)', async () => {
      execAsyncMock.mockResolvedValue(prViewResponse('octocat', 'hello-world', 'main'));

      const { resolvePrRepoContext } = await import('#src/tools/ghReadFileTool.js');
      await resolvePrRepoContext(undefined);

      expect(execAsyncMock).toHaveBeenCalledWith(
        'gh pr view --json headRefName,headRepository,headRepositoryOwner'
      );
    });

    it('rejects a non-numeric prId without invoking gh', async () => {
      const { resolvePrRepoContext } = await import('#src/tools/ghReadFileTool.js');
      const result = await resolvePrRepoContext('pulumi');

      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(result).toContain('Invalid pull request id');
    });

    it('returns an explanation when PR metadata lacks the head repository', async () => {
      execAsyncMock.mockResolvedValue(JSON.stringify({ headRefName: 'x' }));

      const { resolvePrRepoContext } = await import('#src/tools/ghReadFileTool.js');
      const result = await resolvePrRepoContext('1');

      expect(result).toContain('did not include the head repository');
    });

    it('gracefully explains when gh pr view fails', async () => {
      execAsyncMock.mockRejectedValue(new Error('gh: not authenticated'));

      const { resolvePrRepoContext } = await import('#src/tools/ghReadFileTool.js');
      const result = await resolvePrRepoContext('1');

      expect(result).toContain('Could not resolve the pull request repository');
    });
  });

  describe('get(config, prId)', () => {
    it('exposes a built-in tool whose schema only accepts a path', async () => {
      const { get, GTH_GH_READ_FILE_TOOL_NAME } = await import('#src/tools/ghReadFileTool.js');
      const tool = get({} as GthConfig, '368');

      expect(tool.name).toBe(GTH_GH_READ_FILE_TOOL_NAME);
      expect(typeof tool.invoke).toBe('function');
      // owner/repo are NOT part of the input contract — the model cannot supply them.
      const shape = (tool.schema as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape)).toEqual(['path']);
    });

    it('binds owner/repo to the PR under review, ignoring any model-named repo (regression)', async () => {
      // gh pr view → the real PR repo; gh api contents → file content.
      execAsyncMock.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith('gh pr view')) {
          return prViewResponse('Galvanized-Pukeko', 'gaunt-sloth-assistant', 'feature/rel-2');
        }
        return contentsResponse('workflow yaml');
      });

      const { get } = await import('#src/tools/ghReadFileTool.js');
      const tool = get({} as GthConfig, '368');

      const result = (await tool.invoke({
        path: '.github/workflows/integration-tests-small.yml',
      })) as string;

      // It must read from the PR's repo at its head ref — never a model-hallucinated pulumi/pulumi.
      expect(execAsyncMock).toHaveBeenCalledWith(
        'gh api /repos/Galvanized-Pukeko/gaunt-sloth-assistant/contents/.github/workflows/integration-tests-small.yml?ref=feature/rel-2'
      );
      expect(execAsyncMock.mock.calls.some(([cmd]) => String(cmd).includes('pulumi'))).toBe(false);
      expect(result).toContain('workflow yaml');
    });

    it('resolves the PR context only once across multiple reads (memoised)', async () => {
      execAsyncMock.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith('gh pr view')) return prViewResponse('octocat', 'hello-world', 'main');
        return contentsResponse('x');
      });

      const { get } = await import('#src/tools/ghReadFileTool.js');
      const tool = get({} as GthConfig, '7');

      await tool.invoke({ path: 'a.txt' });
      await tool.invoke({ path: 'b.txt' });

      const prViewCalls = execAsyncMock.mock.calls.filter(([cmd]) =>
        String(cmd).startsWith('gh pr view')
      );
      expect(prViewCalls).toHaveLength(1);
    });

    it('returns the resolution error as a graceful skip when the PR cannot be resolved', async () => {
      execAsyncMock.mockRejectedValue(new Error('gh: not authenticated'));

      const { get } = await import('#src/tools/ghReadFileTool.js');
      const tool = get({} as GthConfig, '7');

      const result = (await tool.invoke({ path: 'a.txt' })) as string;
      expect(result).toContain('Could not resolve the pull request repository');
      // The contents endpoint must not be hit when we could not bind the repo.
      expect(execAsyncMock.mock.calls.some(([cmd]) => String(cmd).startsWith('gh api'))).toBe(
        false
      );
    });
  });
});
