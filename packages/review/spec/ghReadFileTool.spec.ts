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

  /**
   * CFG-52 — the decoded text is capped so one call on a large file cannot take an unbounded bite
   * out of the context window. Each case is a PAIR (over the cap AND under it), because the "over"
   * half alone also passes against an implementation that truncates everything, and the "under"
   * half alone against one that never truncates.
   */
  describe('maxBytes cap on the decoded content (CFG-52)', () => {
    const MARKER = 'gth_gh_read_file: file truncated at the';

    it('truncates at the configured boundary with a marker, and leaves smaller files untouched', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');

      const over = 'x'.repeat(500);
      execAsyncMock.mockResolvedValue(contentsResponse(over));
      const truncated = await ghReadFileImpl({ path: 'src/index.ts' }, CTX, 100);

      expect(truncated).toContain(MARKER);
      // The body is cut exactly at the cap — not at the whole file, and not at some other number.
      const body = truncated.split('\n\n')[1].split('\n... [')[0];
      expect(Buffer.byteLength(body, 'utf8')).toBe(100);
      expect(body).toBe('x'.repeat(100));
      // The model must not be told it received the FULL file when it did not.
      expect(truncated).not.toContain('Full contents of');
      expect(truncated).toContain('Partial contents of octocat/hello-world/src/index.ts');
      // The WHOLE marker, once: the cap it names must be the cap that was applied, and the config
      // key must be the one a user can actually turn. Matching only the prefix (as the other cases
      // here do) passes against an implementation that reports the wrong number or points the user
      // at a key that does not exist — the marker is the sole channel by which the model, and
      // through it the reader, learns the file is incomplete and which knob controls that.
      expect(truncated).toBe(
        'Partial contents of octocat/hello-world/src/index.ts (truncated):\n\n' +
          'x'.repeat(100) +
          '\n... [gth_gh_read_file: file truncated at the 100-byte cap ' +
          '(builtInTools.gth_gh_read_file.maxBytes) — this file is INCOMPLETE, ' +
          'the rest was not returned] ...'
      );

      // Under the cap: byte-identical to the decoded file, and no marker at all.
      const under = 'y'.repeat(99);
      execAsyncMock.mockResolvedValue(contentsResponse(under));
      const whole = await ghReadFileImpl({ path: 'src/index.ts' }, CTX, 100);

      expect(whole).not.toContain(MARKER);
      expect(whole).toBe(`Full contents of octocat/hello-world/src/index.ts:\n\n${under}`);
    });

    it('does not truncate content sitting exactly on the cap', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');

      const exact = 'z'.repeat(100);
      execAsyncMock.mockResolvedValue(contentsResponse(exact));
      const result = await ghReadFileImpl({ path: 'src/index.ts' }, CTX, 100);

      expect(result).not.toContain(MARKER);
      expect(result).toBe(`Full contents of octocat/hello-world/src/index.ts:\n\n${exact}`);
    });

    it('never returns more bytes than the cap when the boundary falls mid-character', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');

      // Each "é" is 2 UTF-8 bytes, so a cap of 5 lands inside the third one. Slicing the buffer
      // there and decoding yields a replacement character WIDER than the bytes it replaced, which
      // is how a naive cap overshoots.
      execAsyncMock.mockResolvedValue(contentsResponse('é'.repeat(10)));
      const result = await ghReadFileImpl({ path: 'src/index.ts' }, CTX, 5);

      const body = result.split('\n\n')[1].split('\n... [')[0];
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(5);
      expect(body).toBe('éé');
      expect(result).toContain(MARKER);
    });

    it('applies the default cap when the caller passes none', async () => {
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      const { GH_READ_FILE_DEFAULT_MAX_BYTES } = await import('@gaunt-sloth/core/config.js');

      execAsyncMock.mockResolvedValue(contentsResponse('a'.repeat(GH_READ_FILE_DEFAULT_MAX_BYTES)));
      expect(await ghReadFileImpl({ path: 'src/index.ts' }, CTX)).not.toContain(MARKER);

      execAsyncMock.mockResolvedValue(
        contentsResponse('a'.repeat(GH_READ_FILE_DEFAULT_MAX_BYTES + 1))
      );
      expect(await ghReadFileImpl({ path: 'src/index.ts' }, CTX)).toContain(MARKER);
    });

    it('reads the cap for the command it was built for, from the builtInTools registry', async () => {
      execAsyncMock.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith('gh pr view')) return prViewResponse('octocat', 'hello-world');
        return contentsResponse('q'.repeat(60));
      });

      const { get } = await import('#src/tools/ghReadFileTool.js');
      const config = {
        builtInTools: { gth_gh_read_file: { maxBytes: 500 } },
        commands: { pr: { builtInTools: { gth_gh_read_file: { maxBytes: 50 } } } },
      } as unknown as GthConfig;

      // `pr` takes its own 50-byte cap and truncates…
      const prTool = get(config, '7', 'pr');
      expect((await prTool.invoke({ path: 'a.txt' })) as string).toContain(MARKER);

      // …while `review` falls back to the root 500-byte cap and returns the file whole.
      const reviewTool = get(config, '7', 'review');
      expect((await reviewTool.invoke({ path: 'a.txt' })) as string).not.toContain(MARKER);
    });
  });
});
