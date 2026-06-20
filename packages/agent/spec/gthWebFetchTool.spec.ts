import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('gth_web_fetch tool', () => {
  let tool: any;
  const mockConfig = {} as any;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Tool Definition', () => {
    it('should have correct tool metadata', async () => {
      const { get } = await import('#src/tools/gthWebFetchTool.js');
      tool = get(mockConfig);

      expect(tool.name).toBe('gth_web_fetch');
      expect(tool.description).toBe(
        'Fetch content from a web URL. Provide a valid HTTP/HTTPS URL and get the content as text.'
      );
    });
  });

  describe('URL Validation', () => {
    beforeEach(async () => {
      const { get } = await import('#src/tools/gthWebFetchTool.js');
      tool = get(mockConfig);
    });

    it('should reject invalid URLs', async () => {
      await expect(tool.invoke(undefined)).rejects.toContain('Invalid URL provided');
      await expect(tool.invoke('')).rejects.toContain('Invalid URL provided');
      await expect(tool.invoke('   ')).rejects.toContain('Invalid URL provided');
    });

    it('should reject non-HTTP/HTTPS protocols', async () => {
      await expect(tool.invoke('ftp://example.com')).rejects.toContain(
        'URL must start with http:// or https://'
      );
      await expect(tool.invoke('www.example.com')).rejects.toContain(
        'URL must start with http:// or https://'
      );
    });

    it('should accept valid HTTP/HTTPS URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue('test content'),
      });

      const result = await tool.invoke('https://example.com');
      expect(result).toBe('test content');
    });
  });

  describe('HTTP Request', () => {
    beforeEach(async () => {
      const { get } = await import('#src/tools/gthWebFetchTool.js');
      tool = get(mockConfig);
    });

    it('should make request with correct URL and headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue('content'),
      });

      await tool.invoke('https://example.com');

      expect(mockFetch).toHaveBeenCalledWith('https://example.com', {
        headers: {
          Accept: 'text/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      });
    });

    it('should return response content for successful requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue('success content'),
      });

      const result = await tool.invoke('https://example.com');
      expect(result).toBe('success content');
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      const { get } = await import('#src/tools/gthWebFetchTool.js');
      tool = get(mockConfig);
    });

    it('should handle HTTP error responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(tool.invoke('https://example.com')).rejects.toContain(
        'Failed to fetch data from https://example.com with status: 404 - Not Found'
      );
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network timeout');
      mockFetch.mockRejectedValueOnce(networkError);

      await expect(tool.invoke('https://example.com')).rejects.toContain(
        'Unknown error occurred while fetching content from https://example.com: Error: Network timeout'
      );
    });
  });
});
