import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from 'typedoc';
import { keepInlineCodeInHeadingAnchors } from '../../../scripts/typedoc-github-heading-anchors.mjs';

/**
 * OPS-66 — `docs/` pages are read on GitHub and on the TypeDoc-generated site, and the two slug a
 * heading differently: TypeDoc builds an anchor from the heading's `text` tokens only, so an inline
 * code span contributes nothing and `The ladder: \`approvals\`` anchors as `the-ladder` there and
 * `the-ladder-approvals` on GitHub. `docs/DOC-STYLE.md` makes GitHub's slug authoritative and
 * `scripts/typedoc-github-heading-anchors.mjs` configures TypeDoc to match it.
 *
 * `pnpm typedoc` is not a CI job, so this file is the only thing that notices when the plugin stops
 * working, and the symptom it guards against is silent: links keep rendering, they just stop
 * resolving on the site. Two kinds of test, because the plugin has two halves that fail
 * independently:
 *
 * - the transform, over a synthetic markdown-it token stream — fast, and each test pairs the case
 *   it is about with a heading the rule must still change, so a rule that stopped transforming
 *   anything cannot pass by doing nothing;
 * - the wiring, over a real `Application` rendering a real one-page site with the plugin list read
 *   out of `typedoc.json` — the only assertion that can tell a registered plugin from an effective
 *   one, and the only one that fails when `load()` is left in place but stops reaching the anchor
 *   generator.
 */

/** markdown-it's token shape, reduced to the fields the rule and TypeDoc's anchor code read. */
class FakeToken {
  content = '';
  children: FakeToken[] | null = null;
  constructor(
    public type: string,
    public tag: string,
    public nesting: number
  ) {}
}

function text(content: string): FakeToken {
  const token = new FakeToken('text', '', 0);
  token.content = content;
  return token;
}

function codeSpan(content: string): FakeToken {
  const token = new FakeToken('code_inline', 'code', 0);
  token.content = content;
  return token;
}

function inline(children: FakeToken[]): FakeToken {
  const token = new FakeToken('inline', '', 0);
  token.children = children;
  return token;
}

/** `heading_open` · `inline` · `heading_close`, the shape markdown-it emits for an ATX heading. */
function heading(children: FakeToken[]): FakeToken[] {
  return [
    new FakeToken('heading_open', 'h2', 1),
    inline(children),
    new FakeToken('heading_close', 'h2', -1),
  ];
}

function paragraph(children: FakeToken[]): FakeToken[] {
  return [
    new FakeToken('paragraph_open', 'p', 1),
    inline(children),
    new FakeToken('paragraph_close', 'p', -1),
  ];
}

/**
 * TypeDoc's own `getTokenTextContent` (`typedoc/dist/index.js`), which is the function that decides
 * what a heading's anchor is built from. Reproduced rather than imported because TypeDoc does not
 * export it; it is six lines and its contract — `children` first, then `text` tokens, everything
 * else the empty string — is what the plugin exploits. The render test below does not depend on
 * this copy staying faithful: it reads the id TypeDoc's real anchor code emitted.
 */
function anchorSource(token: FakeToken): string {
  if (token.children) return token.children.map(anchorSource).join('');
  if (token.type === 'text') return token.content;
  return '';
}

/** Runs the plugin's core rule over a token stream, the way markdown-it would. */
function applyRule(tokens: FakeToken[]): FakeToken[] {
  const rules: Array<(state: unknown) => void> = [];
  const md = {
    core: { ruler: { push: (_name: string, fn: (state: unknown) => void) => rules.push(fn) } },
  };
  keepInlineCodeInHeadingAnchors(md);
  expect(rules).toHaveLength(1);
  rules[0]({ tokens, Token: FakeToken });
  return tokens;
}

describe('OPS-66 TypeDoc heading anchors keep inline-code text', () => {
  it('feeds the code span text to the anchor generator', () => {
    const tokens = heading([text('The ladder: '), codeSpan('approvals')]);
    // Control: this is what TypeDoc anchors on without the plugin, and why the link written
    // against GitHub's `#the-ladder-approvals` was reported broken on the site.
    expect(anchorSource(tokens[1])).toBe('The ladder: ');

    applyRule(tokens);

    expect(anchorSource(tokens[1])).toBe('The ladder: approvals');
  });

  it('leaves what markdown-it renders untouched', () => {
    // markdown-it renders `code_inline` from `content` and never looks at `children`, which is the
    // whole reason this is safe: the anchor changes, the rendered heading does not.
    const tokens = heading([text('What '), codeSpan('approvals.json'), text(' answers')]);
    applyRule(tokens);

    const span = tokens[1].children![1];
    expect(span.type).toBe('code_inline');
    expect(span.content).toBe('approvals.json');
    expect(tokens[1].children!.map((child) => child.content)).toEqual([
      'What ',
      'approvals.json',
      ' answers',
    ]);
    expect(anchorSource(tokens[1])).toBe('What approvals.json answers');
  });

  it('ignores code spans outside headings', () => {
    // The heading carries the same code span as the paragraph, and is the control: one run of the
    // rule has to leave the paragraph alone *and* change the heading, so a rule that stopped
    // matching anything at all fails here rather than passing on the untouched paragraph.
    const tokens = [
      ...paragraph([text('Set '), codeSpan('approvals'), text(' in your config.')]),
      ...heading([text('Set '), codeSpan('approvals')]),
    ];
    applyRule(tokens);

    expect(tokens[1].children![1].children).toBeNull();
    expect(anchorSource(tokens[1])).toBe('Set  in your config.');
    expect(anchorSource(tokens[4])).toBe('Set approvals');
  });

  it('leaves a heading with no code span alone', () => {
    // Same shape: the second heading is the control that a no-op rule cannot satisfy.
    const tokens = [...heading([text('Configuration')]), ...heading([codeSpan('approvals')])];
    applyRule(tokens);

    expect(tokens[1].children!.map((child) => [child.type, child.content, child.children])).toEqual(
      [['text', 'Configuration', null]]
    );
    expect(anchorSource(tokens[4])).toBe('approvals');
  });

  it('is idempotent', () => {
    const tokens = heading([codeSpan('approvals')]);
    applyRule(tokens);
    const firstPass = tokens[1].children![0].children;
    expect(firstPass).toHaveLength(1);

    applyRule(tokens);

    // Identity, not length: the rule *assigns* `children`, so a second pass without the bail-out
    // would replace the array with a new one of the same length and every count-based assertion
    // would still hold. This is the only assertion that fails when the bail-out is removed.
    expect(tokens[1].children![0].children).toBe(firstPass);
    expect(anchorSource(tokens[1])).toBe('approvals');
  });

  it('is registered in typedoc.json and reaches the anchors of a real TypeDoc render', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const config = JSON.parse(readFileSync(join(repoRoot, 'typedoc.json'), 'utf8'));
    expect(config.plugin ?? []).toContain('./scripts/typedoc-github-heading-anchors.mjs');

    // `entryPoints` and `projectDocuments` are glob options, and TypeDoc rejects a glob containing
    // a backslash outright, so these must be POSIX-slashed to work on Windows. `plugin` is not a
    // glob — an absolute native path is fine there.
    //
    // Being globs, they are also matched rather than compared: TypeDoc passes an absolute path
    // straight through to minimatch without escaping it, so a `[` anywhere in the temp directory
    // matches nothing and this test fails with `project` undefined. No CI runner's temp dir has
    // one; a developer machine could.
    const posix = (p: string) => p.replace(/\\/g, '/');
    const dir = mkdtempSync(join(tmpdir(), 'ops66-typedoc-'));
    try {
      writeFileSync(join(dir, 'index.ts'), 'export const answer = 42;\n');
      writeFileSync(
        join(dir, 'page.md'),
        [
          '---',
          'title: Probe',
          '---',
          '',
          '## The ladder: `approvals`',
          '',
          '## Plain heading',
          '',
        ].join('\n')
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' },
          include: ['index.ts'],
        })
      );

      const out = join(dir, 'out');
      const app = await Application.bootstrapWithPlugins(
        {
          entryPoints: [posix(join(dir, 'index.ts'))],
          projectDocuments: [posix(join(dir, 'page.md'))],
          tsconfig: posix(join(dir, 'tsconfig.json')),
          out: posix(out),
          // The plugin list is read from typedoc.json rather than hardcoded, so this render is
          // driven by the same registration the site build uses.
          plugin: (config.plugin ?? []).map((entry: string) => resolve(repoRoot, entry)),
          skipErrorChecking: true,
          // Warnings stay on deliberately. TypeDoc reports a glob that matched no files at `warn`,
          // and that is the one line explaining every environment-shaped failure of this test —
          // silencing it leaves a bare `project` undefined pointing at nothing. `name` is set only
          // to suppress the benign warning a successful run would otherwise print.
          name: 'Probe',
        },
        []
      );
      const project = await app.convert();
      expect(project).toBeDefined();
      await app.generateDocs(project!, out);

      const html = readFileSync(join(out, 'documents', 'Probe.html'), 'utf8');
      const headingIds = [...html.matchAll(/<h2 id="([^"]*)"/g)].map((match) => match[1]);
      // Both slugs are GitHub's, read off GitHub's own renderer. Without the plugin reaching the
      // anchor generator the first one is `the-ladder`, which is the divergence this node closed;
      // the plain heading is the control that does not move either way. Compared as the whole
      // list, so a page that rendered nothing fails here rather than passing vacuously.
      expect(headingIds).toEqual(['the-ladder-approvals', 'plain-heading']);
      // ...and the rendered heading itself is untouched: the anchor changed, the markup did not.
      expect(html).toContain('The ladder: <code>approvals</code>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
