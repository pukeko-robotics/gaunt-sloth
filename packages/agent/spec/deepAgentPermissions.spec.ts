import { describe, expect, it } from 'vitest';
import {
  aiignoreToPermissions,
  buildPermissions,
  filesystemModeToPermissions,
  FILESYSTEM_TOOL_NAMES,
} from '#src/core/deepAgentPermissions.js';

describe('deepAgentPermissions', () => {
  describe('aiignoreToPermissions', () => {
    it('expands a bare pattern to a top-level and a recursive deny rule', () => {
      const rules = aiignoreToPermissions(['*.env']);
      expect(rules).toEqual([
        { operations: ['read', 'write'], paths: ['/*.env', '/**/*.env'], mode: 'deny' },
      ]);
    });

    it('anchors a path-containing pattern as-is plus its subtree', () => {
      const rules = aiignoreToPermissions(['config/secrets.json']);
      expect(rules).toEqual([
        {
          operations: ['read', 'write'],
          paths: ['/config/secrets.json', '/config/secrets.json/**'],
          mode: 'deny',
        },
      ]);
    });

    it('emits one rule per pattern and skips empty/normalized-empty patterns', () => {
      const rules = aiignoreToPermissions(['*.env', 'config/secrets.json', '', './', '/']);
      expect(rules).toHaveLength(2);
    });

    it('strips a leading ./ or / and a trailing slash before anchoring', () => {
      // Both normalize to bare names (no internal slash) → top-level + recursive.
      const rules = aiignoreToPermissions(['./build/', '/dist']);
      expect(rules.map((r) => r.paths)).toEqual([
        ['/build', '/**/build'],
        ['/dist', '/**/dist'],
      ]);
    });
  });

  describe('filesystemModeToPermissions', () => {
    it('"all" contributes no rules', () => {
      expect(filesystemModeToPermissions('all')).toEqual([]);
    });

    it('"read" denies all writes', () => {
      expect(filesystemModeToPermissions('read')).toEqual([
        { operations: ['write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('"none" denies all reads and writes', () => {
      expect(filesystemModeToPermissions('none')).toEqual([
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('an allow-list permits each dir then denies everything else (deny last)', () => {
      const rules = filesystemModeToPermissions(['src', './docs/']);
      expect(rules).toEqual([
        { operations: ['read', 'write'], paths: ['/src/**', '/src'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/docs/**', '/docs'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });
  });

  describe('buildPermissions', () => {
    it('puts .aiignore deny rules first so they win over allow rules', () => {
      const rules = buildPermissions({
        filesystem: ['src'],
        aiignore: { enabled: true, patterns: ['*.env'] },
      });
      // aiignore rule first, then the allow-list rules, then the catch-all deny.
      expect(rules[0]).toEqual({
        operations: ['read', 'write'],
        paths: ['/*.env', '/**/*.env'],
        mode: 'deny',
      });
      expect(rules[rules.length - 1]).toEqual({
        operations: ['read', 'write'],
        paths: ['/**'],
        mode: 'deny',
      });
    });

    it('filesystem "all" + two ignore patterns yields only the two deny rules', () => {
      const rules = buildPermissions({
        filesystem: 'all',
        aiignore: { enabled: true, patterns: ['*.env', 'config/secrets.json'] },
      });
      expect(rules).toHaveLength(2);
      expect(rules.every((r) => r.mode === 'deny')).toBe(true);
    });

    it('skips .aiignore when explicitly disabled', () => {
      const rules = buildPermissions({
        filesystem: 'all',
        aiignore: { enabled: false, patterns: ['*.env'] },
      });
      expect(rules).toEqual([]);
    });

    it('skips .aiignore when there are no patterns or no aiignore block', () => {
      expect(buildPermissions({ filesystem: 'all' })).toEqual([]);
      expect(buildPermissions({ filesystem: 'all', aiignore: { patterns: [] } })).toEqual([]);
    });
  });

  describe('FILESYSTEM_TOOL_NAMES', () => {
    it('mirrors the deepagents reserved filesystem tool names', () => {
      expect([...FILESYSTEM_TOOL_NAMES]).toEqual([
        'ls',
        'read_file',
        'write_file',
        'edit_file',
        'glob',
        'grep',
        'execute',
      ]);
    });
  });
});
