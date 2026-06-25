import { describe, expect, it, vi } from 'vitest';

// Anchor getCurrentWorkDir deterministically for the --allow-dir (real-path) permission tests.
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  getCurrentWorkDir: () => '/work/proj',
}));

import {
  aiignoreToPermissions,
  allowDirsToPermissions,
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

    it('anchors rules at an absolute base when one is supplied (widened real-path mode)', () => {
      const rules = aiignoreToPermissions(['*.env'], '/work/proj');
      expect(rules).toEqual([
        {
          operations: ['read', 'write'],
          paths: ['/work/proj/*.env', '/work/proj/**/*.env'],
          mode: 'deny',
        },
      ]);
    });
  });

  describe('allowDirsToPermissions', () => {
    it('allow-lists cwd + each (resolved) extra dir, then denies everything else', () => {
      const rules = allowDirsToPermissions(['../shared', '/tmp/out']);
      expect(rules).toEqual([
        { operations: ['read', 'write'], paths: ['/work/proj/**', '/work/proj'], mode: 'allow' },
        {
          operations: ['read', 'write'],
          paths: ['/work/shared/**', '/work/shared'],
          mode: 'allow',
        },
        { operations: ['read', 'write'], paths: ['/tmp/out/**', '/tmp/out'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('de-dupes a dir that resolves back to cwd', () => {
      const rules = allowDirsToPermissions(['.']);
      // Only one allow rule (cwd) plus the catch-all deny.
      expect(rules).toHaveLength(2);
      expect(rules[0].paths).toEqual(['/work/proj/**', '/work/proj']);
      expect(rules[1].mode).toEqual('deny');
    });
  });

  describe('filesystemModeToPermissions (EXT-13: real-cwd-anchored default sandbox)', () => {
    it('"all" applies the cwd sandbox: allow cwd/**, deny everything else', () => {
      // No virtualMode chroot anymore — the cwd allow + catch-all deny enforce containment.
      expect(filesystemModeToPermissions('all')).toEqual([
        { operations: ['read', 'write'], paths: ['/work/proj/**', '/work/proj'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('"read" denies all writes and confines reads to the cwd sandbox', () => {
      expect(filesystemModeToPermissions('read')).toEqual([
        { operations: ['write'], paths: ['/**'], mode: 'deny' },
        { operations: ['read'], paths: ['/work/proj/**', '/work/proj'], mode: 'allow' },
        { operations: ['read'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('"none" denies all reads and writes', () => {
      expect(filesystemModeToPermissions('none')).toEqual([
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('an allow-list resolves each dir against the real cwd then denies everything else', () => {
      const rules = filesystemModeToPermissions(['src', './docs/']);
      expect(rules).toEqual([
        {
          operations: ['read', 'write'],
          paths: ['/work/proj/src/**', '/work/proj/src'],
          mode: 'allow',
        },
        {
          operations: ['read', 'write'],
          paths: ['/work/proj/docs/**', '/work/proj/docs'],
          mode: 'allow',
        },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('accepts an explicit cwd argument (overrides getCurrentWorkDir)', () => {
      expect(filesystemModeToPermissions('all', '/custom/root')).toEqual([
        {
          operations: ['read', 'write'],
          paths: ['/custom/root/**', '/custom/root'],
          mode: 'allow',
        },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });
  });

  describe('filesystemModeToPermissions (EXT-16: virtualMode → virtual-root sandbox)', () => {
    // In virtualMode the rules anchor at the virtual root "/" (= cwd) and IGNORE the real cwd,
    // so a Windows `D:\...` cwd never leaks into a glob (deepagents' validatePath would reject it).
    const WIN_CWD = 'D:\\a\\proj';

    it('"all" anchors the sandbox at the virtual root, ignoring the real cwd', () => {
      expect(filesystemModeToPermissions('all', WIN_CWD, true)).toEqual([
        { operations: ['read', 'write'], paths: ['/**', '/'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('"read" denies writes and confines reads to the virtual root', () => {
      expect(filesystemModeToPermissions('read', WIN_CWD, true)).toEqual([
        { operations: ['write'], paths: ['/**'], mode: 'deny' },
        { operations: ['read'], paths: ['/**', '/'], mode: 'allow' },
        { operations: ['read'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('an allow-list anchors each dir under the virtual root', () => {
      expect(filesystemModeToPermissions(['src', './docs/'], WIN_CWD, true)).toEqual([
        { operations: ['read', 'write'], paths: ['/src/**', '/src'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/docs/**', '/docs'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('emits ONLY POSIX `/`-rooted paths even with a Windows cwd (deepagents invariant)', () => {
      // deepagents' validatePath throws on any permission path not starting with "/". This is the
      // exact guarantee that fixes the Windows hang, so assert it across every mode.
      for (const mode of ['all', 'read', 'none', ['src', 'docs/sub']] as const) {
        for (const p of filesystemModeToPermissions(mode, WIN_CWD, true).flatMap((r) => r.paths)) {
          expect(p.startsWith('/')).toBe(true);
          expect(p.includes('\\')).toBe(false);
        }
      }
    });
  });

  describe('buildPermissions', () => {
    it('puts .aiignore deny rules first so they win over allow rules (real-cwd anchored)', () => {
      const rules = buildPermissions({
        filesystem: ['src'],
        aiignore: { enabled: true, patterns: ['*.env'] },
      });
      // EXT-13: aiignore + allow-list now anchor at the real cwd in the default case too.
      expect(rules[0]).toEqual({
        operations: ['read', 'write'],
        paths: ['/work/proj/*.env', '/work/proj/**/*.env'],
        mode: 'deny',
      });
      expect(rules[rules.length - 1]).toEqual({
        operations: ['read', 'write'],
        paths: ['/**'],
        mode: 'deny',
      });
    });

    it('filesystem "all" + two ignore patterns: aiignore denies first, then the cwd sandbox', () => {
      const rules = buildPermissions({
        filesystem: 'all',
        aiignore: { enabled: true, patterns: ['*.env', 'config/secrets.json'] },
      });
      // 2 aiignore deny rules + (cwd allow, catch-all deny) from the "all" sandbox.
      expect(rules).toHaveLength(4);
      expect(rules[0]).toEqual({
        operations: ['read', 'write'],
        paths: ['/work/proj/*.env', '/work/proj/**/*.env'],
        mode: 'deny',
      });
      // The cwd sandbox allow rule is present and the last rule is the catch-all deny.
      expect(rules).toContainEqual({
        operations: ['read', 'write'],
        paths: ['/work/proj/**', '/work/proj'],
        mode: 'allow',
      });
      expect(rules[rules.length - 1]).toEqual({
        operations: ['read', 'write'],
        paths: ['/**'],
        mode: 'deny',
      });
    });

    it('skips .aiignore when explicitly disabled (but keeps the cwd sandbox)', () => {
      const rules = buildPermissions({
        filesystem: 'all',
        aiignore: { enabled: false, patterns: ['*.env'] },
      });
      expect(rules).toEqual([
        { operations: ['read', 'write'], paths: ['/work/proj/**', '/work/proj'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('skips .aiignore when there are no patterns or no aiignore block (cwd sandbox remains)', () => {
      const expected = [
        { operations: ['read', 'write'], paths: ['/work/proj/**', '/work/proj'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ];
      expect(buildPermissions({ filesystem: 'all' })).toEqual(expected);
      expect(buildPermissions({ filesystem: 'all', aiignore: { patterns: [] } })).toEqual(expected);
    });

    it('allowDirs replaces filesystem-mode rules with the cwd + dirs allow-list (real paths)', () => {
      const rules = buildPermissions({ filesystem: 'all', allowDirs: ['/tmp/out'] });
      expect(rules).toEqual([
        { operations: ['read', 'write'], paths: ['/work/proj/**', '/work/proj'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/tmp/out/**', '/tmp/out'], mode: 'allow' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
      ]);
    });

    it('with allowDirs, .aiignore deny rules are anchored at the absolute cwd and come first', () => {
      const rules = buildPermissions({
        filesystem: 'all',
        allowDirs: ['/tmp/out'],
        aiignore: { enabled: true, patterns: ['*.env'] },
      });
      expect(rules[0]).toEqual({
        operations: ['read', 'write'],
        paths: ['/work/proj/*.env', '/work/proj/**/*.env'],
        mode: 'deny',
      });
      // allow-list follows, catch-all deny last.
      expect(rules[rules.length - 1]).toEqual({
        operations: ['read', 'write'],
        paths: ['/**'],
        mode: 'deny',
      });
    });

    describe('virtual mode (EXT-16, Windows)', () => {
      it('anchors aiignore + the sandbox at the virtual root, not the real cwd', () => {
        const rules = buildPermissions(
          { filesystem: 'all', aiignore: { enabled: true, patterns: ['*.env'] } },
          true
        );
        expect(rules).toEqual([
          { operations: ['read', 'write'], paths: ['/*.env', '/**/*.env'], mode: 'deny' },
          { operations: ['read', 'write'], paths: ['/**', '/'], mode: 'allow' },
          { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
        ]);
      });

      it('ignores allowDirs (cannot widen a virtual root) and keeps the cwd-only sandbox', () => {
        const rules = buildPermissions({ filesystem: 'all', allowDirs: ['/tmp/out'] }, true);
        expect(rules).toEqual([
          { operations: ['read', 'write'], paths: ['/**', '/'], mode: 'allow' },
          { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
        ]);
      });
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
