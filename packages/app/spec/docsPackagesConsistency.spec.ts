import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GS2-2 B7 — docs-vs-package.json consistency for every workspace package.
 *
 * Asserts, for each `packages/<dir>`:
 *  - a README.md exists and its title (first `# ` heading) is exactly the package name;
 *  - every bin in the package's bin map is documented (its name appears in the README);
 *  - reverse: every bin-shaped name documented in code spans/fences across all package
 *    READMEs exists in some package's bin map — so a retired bin (e.g. the pre-2.0
 *    `gaunt-sloth-assistant`) can't linger in docs after it leaves the bin maps.
 *
 * Bin-shaped means a whole backtick/fence token matching gaunt-sloth, gsloth, gth or a
 * dashed suffix of those (`gth-batch`, `gaunt-sloth-review`, ...). Scoped package names
 * (@gaunt-sloth/...), paths, and URLs never match, so prose and examples don't trip it.
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packagesDir = path.join(rootDir, 'packages');

const packageDirs = fs
  .readdirSync(packagesDir)
  .filter((d) => fs.existsSync(path.join(packagesDir, d, 'package.json')));

interface PkgInfo {
  dir: string;
  name: string;
  bins: string[];
  readmePath: string;
}

const packages: PkgInfo[] = packageDirs.map((dir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packagesDir, dir, 'package.json'), 'utf8'));
  return {
    dir,
    name: pkg.name,
    bins: Object.keys(pkg.bin ?? {}),
    readmePath: path.join(packagesDir, dir, 'README.md'),
  };
});

const allBins = new Set(packages.flatMap((p) => p.bins));

const BIN_SHAPED = /^(gaunt-sloth|gsloth|gth)(-[a-z][a-z0-9-]*)?$/;

/**
 * Documented identifiers that match the bin shape but are not bins. Add here ONLY things
 * verified against source (e.g. `gth-agent` is an eval-suite `target.type` value, see
 * packages/batch/src/evalSuite.ts) — never a command name.
 */
const NON_BIN_IDENTIFIERS = new Set(['gth-agent']);

/** Extract the contents of fenced code blocks and inline code spans from markdown. */
function extractCodeText(markdown: string): string[] {
  const chunks: string[] = [];
  const fences = markdown.match(/```[\s\S]*?```/g) ?? [];
  for (const fence of fences) {
    chunks.push(fence.replace(/```[^\n]*\n?/g, ''));
  }
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
  const spans = withoutFences.match(/`[^`\n]+`/g) ?? [];
  for (const span of spans) {
    chunks.push(span.slice(1, -1));
  }
  return chunks;
}

/** Bin-shaped tokens documented in a README's code spans/fences. */
function documentedBinTokens(markdown: string): string[] {
  const tokens = new Set<string>();
  for (const chunk of extractCodeText(markdown)) {
    for (const raw of chunk.split(/\s+/)) {
      // Trim surrounding punctuation (quotes, commas, colons) from JSON/shell examples.
      const token = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
      if (BIN_SHAPED.test(token) && !NON_BIN_IDENTIFIERS.has(token)) {
        tokens.add(token);
      }
    }
  }
  return [...tokens];
}

describe('packages docs <-> package.json consistency', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('finds the workspace packages', () => {
    expect(packages.length).toBeGreaterThanOrEqual(7);
  });

  it.each(packages.map((p) => [p.dir, p] as const))(
    'packages/%s README title matches the package name',
    (_dir, pkg) => {
      expect(fs.existsSync(pkg.readmePath), `${pkg.name} has no README.md`).toBe(true);
      const readme = fs.readFileSync(pkg.readmePath, 'utf8');
      const title = readme.match(/^# (.+)$/m)?.[1]?.trim();
      expect(title).toBe(pkg.name);
    }
  );

  it.each(packages.filter((p) => p.bins.length > 0).map((p) => [p.dir, p] as const))(
    'packages/%s README documents every bin in its bin map',
    (_dir, pkg) => {
      const readme = fs.readFileSync(pkg.readmePath, 'utf8');
      for (const bin of pkg.bins) {
        expect(readme, `bin "${bin}" of ${pkg.name} is not mentioned in its README`).toContain(bin);
      }
    }
  );

  it('every bin-shaped name documented in package READMEs exists in a bin map', () => {
    // `gaunt-sloth` and `gth` prefixes also name the packages/commands themselves; the bin
    // maps happen to cover those exact tokens (gaunt-sloth, gsloth, gth), so any bin-shaped
    // token NOT in a bin map is stale documentation (e.g. a retired bin).
    for (const pkg of packages) {
      if (!fs.existsSync(pkg.readmePath)) continue;
      const readme = fs.readFileSync(pkg.readmePath, 'utf8');
      for (const token of documentedBinTokens(readme)) {
        expect(
          allBins.has(token),
          `packages/${pkg.dir}/README.md documents "${token}" which is not a bin of any workspace package`
        ).toBe(true);
      }
    }
  });
});
