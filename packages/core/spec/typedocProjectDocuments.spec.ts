import { describe, expect, it } from 'vitest';
import { globSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * OPS-65 — `typedoc.json`'s `projectDocuments` decides which `docs/` pages exist as pages at all.
 *
 * Two failure modes, both silent, both already seen:
 *
 * - A listed path that no longer exists renders nothing. TypeDoc says `did not match any files`
 *   inside a stream of hundreds of warnings and still exits 0, so the rendering check
 *   `docs/DOC-STYLE.md` rule 8 requires keeps "passing" while covering less than it claims.
 * - A `docs/` page that no entry matches is *worse*, because TypeDoc says nothing at all: a
 *   relative link from a rendered page to an unlisted `.md` file is treated as a media asset,
 *   copied into `docs-generated/media/`, and served to the reader as a raw markdown download.
 *
 * Neither shows up in a markdown diff, in lint, or in a page's own rendered output, which is why
 * this is asserted here rather than left to whoever next edits the list.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);
const TYPEDOC_JSON = new URL('typedoc.json', REPO_ROOT);

/**
 * `globSync` wants a plain path for `cwd`, and hands results back with the platform's separator —
 * hence the normalisation on the way out. Nothing here compares a POSIX path literal against a
 * built path, which is the shape that historically passed everywhere except the Windows cell.
 */
const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT);
const toPosix = (p: string): string => p.split('\\').join('/');

/**
 * `docs/` pages that are deliberately not part of the published site. `DOC-STYLE.md` is the
 * authoring ruleset itself — a contributor doc, read on GitHub. Anything else contributor-facing
 * belongs in `maintenance/`, not here (see DOC-STYLE's scope section), so this list should stay
 * at one entry.
 */
const NOT_PUBLISHED = ['docs/DOC-STYLE.md'];

function projectDocuments(): string[] {
  const config = JSON.parse(readFileSync(TYPEDOC_JSON, 'utf8'));
  return (config.projectDocuments ?? []) as string[];
}

/** Every existing file an entry resolves to, repo-root-relative. */
function matchesOf(entry: string): string[] {
  return globSync(entry, { cwd: REPO_ROOT_PATH }).map(toPosix).sort();
}

/** Every markdown page under `docs/`, recursively, repo-root-relative. */
function docsPages(): string[] {
  const found: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(new URL(relativeDir, REPO_ROOT), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${relativeDir}${entry.name}/`);
      else if (entry.name.endsWith('.md')) found.push(`${relativeDir}${entry.name}`);
    }
  };
  walk('docs/');
  return found.sort();
}

describe('OPS-65 typedoc projectDocuments covers the docs it claims to', () => {
  it('resolves entries against the real tree', () => {
    // Control: without this, an always-empty matcher would make "unmatched page" assertions fail
    // for the wrong reason, and an always-matching one would make "entry exists" vacuously true.
    expect(matchesOf('typedoc.json')).toEqual(['typedoc.json']);
    expect(matchesOf('docs/configuration/*.md')).toContain('docs/configuration/index.md');
    expect(matchesOf('docs/no-such-page.md')).toEqual([]);
    expect(matchesOf('docs/no-such-tree/*.md')).toEqual([]);
  });

  it('has a non-empty list and a non-empty docs tree', () => {
    // Anti-vacuity: a renamed key or a moved docs tree would otherwise make every `it.each` below
    // iterate over nothing and report green.
    expect(projectDocuments().length).toBeGreaterThan(0);
    expect(docsPages().length).toBeGreaterThan(0);
  });

  it.each(projectDocuments())('%s matches at least one file', (entry) => {
    expect(
      matchesOf(entry),
      `typedoc.json lists "${entry}", which matches nothing. TypeDoc renders no page for it and ` +
        `still exits 0, so the DOC-STYLE rule 8 rendering check silently stops covering it.`
    ).not.toEqual([]);
  });

  it('leaves no docs page unrendered', () => {
    const matched = new Set(projectDocuments().flatMap(matchesOf));
    const unmatched = docsPages().filter(
      (page) => !matched.has(page) && !NOT_PUBLISHED.includes(page)
    );
    expect(
      unmatched,
      `These pages under docs/ are not matched by typedoc.json's projectDocuments, so the site ` +
        `serves them as raw markdown downloads rather than pages. Add them to the list, or move ` +
        `contributor-facing content to maintenance/ where DOC-STYLE says it belongs.`
    ).toEqual([]);
  });

  it.each(NOT_PUBLISHED)('%s is a real file, so the exclusion still means something', (page) => {
    expect(matchesOf(page)).toEqual([page]);
  });
});
