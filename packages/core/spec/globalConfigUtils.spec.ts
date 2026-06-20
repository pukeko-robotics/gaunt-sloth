import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  ensureGlobalAuthDir,
  ensureGlobalGslothDir,
  getGlobalAuthDir,
  getGlobalGslothConfigReadPath,
  getGlobalGslothConfigWritePath,
  getGlobalGslothDir,
  getOAuthStoragePath,
} from '#src/utils/globalConfigUtils.js';
import { GSLOTH_AUTH, GSLOTH_DIR, USER_PROJECT_CONFIG_JSON } from '#src/constants.js';

vi.mock('node:fs');
vi.mock('node:os');

describe('globalConfigUtils', () => {
  const mockHomeDir = '/home/testuser';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(homedir).mockReturnValue(mockHomeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getGlobalGslothDir', () => {
    it('should return the correct path to global .gsloth directory', () => {
      const result = getGlobalGslothDir();
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR));
    });
  });

  describe('ensureGlobalGslothDir', () => {
    it('should create directory if it does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = ensureGlobalGslothDir();

      expect(mkdirSync).toHaveBeenCalledWith(resolve(mockHomeDir, GSLOTH_DIR), { recursive: true });
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR));
    });

    it('should not create directory if it already exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const result = ensureGlobalGslothDir();

      expect(mkdirSync).not.toHaveBeenCalled();
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR));
    });
  });

  describe('getGlobalGslothConfigReadPath', () => {
    it('should resolve a config filename inside the global .gsloth directory', () => {
      const result = getGlobalGslothConfigReadPath(USER_PROJECT_CONFIG_JSON);
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR, USER_PROJECT_CONFIG_JSON));
    });

    it('should not create the directory (read-only resolver)', () => {
      getGlobalGslothConfigReadPath(USER_PROJECT_CONFIG_JSON);
      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('getGlobalGslothConfigWritePath', () => {
    it('should ensure the global directory exists and resolve the filename', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = getGlobalGslothConfigWritePath(USER_PROJECT_CONFIG_JSON);

      expect(mkdirSync).toHaveBeenCalledWith(resolve(mockHomeDir, GSLOTH_DIR), { recursive: true });
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR, USER_PROJECT_CONFIG_JSON));
    });
  });

  describe('getGlobalAuthDir', () => {
    it('should return the correct path to global auth directory', () => {
      const result = getGlobalAuthDir();
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH));
    });
  });

  describe('ensureGlobalAuthDir', () => {
    it('should create auth directory and parent if they do not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = ensureGlobalAuthDir();

      expect(mkdirSync).toHaveBeenCalledTimes(2);
      expect(mkdirSync).toHaveBeenCalledWith(resolve(mockHomeDir, GSLOTH_DIR), { recursive: true });
      expect(mkdirSync).toHaveBeenCalledWith(resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH), {
        recursive: true,
      });
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH));
    });

    it('should only create auth directory if parent exists', () => {
      vi.mocked(existsSync)
        .mockReturnValueOnce(true) // parent exists
        .mockReturnValueOnce(false); // auth dir doesn't exist

      const result = ensureGlobalAuthDir();

      expect(mkdirSync).toHaveBeenCalledTimes(1);
      expect(mkdirSync).toHaveBeenCalledWith(resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH), {
        recursive: true,
      });
      expect(result).toBe(resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH));
    });
  });

  describe('getOAuthStoragePath', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true); // directories exist
    });

    it('should create safe filename from HTTPS URL', () => {
      const result = getOAuthStoragePath('https://api.example.com/oauth');
      expect(result).toBe(
        resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH, 'api.example.com_oauth.json')
      );
    });

    it('should create safe filename from HTTP URL', () => {
      const result = getOAuthStoragePath('http://localhost:8080/auth');
      expect(result).toBe(
        resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH, 'localhost_8080_auth.json')
      );
    });

    it('should handle URLs with special characters', () => {
      const result = getOAuthStoragePath('https://api.example.com/v1/oauth?client=test');
      expect(result).toBe(
        resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH, 'api.example.com_v1_oauth_client_test.json')
      );
    });

    it('should handle multiple consecutive special characters', () => {
      const result = getOAuthStoragePath('https://api.example.com///oauth');
      expect(result).toBe(
        resolve(mockHomeDir, GSLOTH_DIR, GSLOTH_AUTH, 'api.example.com_oauth.json')
      );
    });
  });

  describe('cross-platform compatibility', () => {
    it('should work on Windows paths', () => {
      const windowsHome = 'C:\\Users\\testuser';
      vi.mocked(homedir).mockReturnValue(windowsHome);

      const gslothDir = getGlobalGslothDir();
      const authDir = getGlobalAuthDir();
      const oauthPath = getOAuthStoragePath('https://example.com');

      // resolve() handles platform-specific path separators
      expect(gslothDir).toBe(resolve(windowsHome, GSLOTH_DIR));
      expect(authDir).toBe(resolve(windowsHome, GSLOTH_DIR, GSLOTH_AUTH));
      expect(oauthPath).toContain('example.com.json');
    });

    it('should work on Unix paths', () => {
      const unixHome = '/home/testuser';
      vi.mocked(homedir).mockReturnValue(unixHome);

      const gslothDir = getGlobalGslothDir();
      const authDir = getGlobalAuthDir();
      const oauthPath = getOAuthStoragePath('https://example.com');

      expect(gslothDir).toBe(resolve(unixHome, GSLOTH_DIR));
      expect(authDir).toBe(resolve(unixHome, GSLOTH_DIR, GSLOTH_AUTH));
      expect(oauthPath).toContain('example.com.json');
    });
  });
});
