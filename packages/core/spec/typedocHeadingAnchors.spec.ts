import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  keepInlineCodeInHeadingAnchors,
  load,
} from '../../../scripts/typedoc-github-heading-anchors.mjs';

/**
 * OPS-66 — `docs/` pages are read on GitHub and on the TypeDoc-generated site, and the two slug a
 * heading differently: TypeDoc builds an anchor from the heading's `text` tokens only, so an inline
 * code span contributes nothing and `The ladder: \`approvals\`` anchors as `the-ladder` there and
 * `the-ladder-approvals` on GitHub. `docs/DOC-STYLE.md` makes GitHub's slug authoritative and
 * `scripts/typedoc-github-heading-anchors.mjs` configures TypeDoc to match it.
 *
 * `pnpm typedoc` is not a CI job, so nothing else would notice the plugin being dropped from
 * `typedoc.json`, renamed, or quietly turned into a no-op — and the symptom is silent: links keep
 * rendering, they just stop resolving on the site.
 *
 * The assertions below are a discriminating pair on the same token stream: the anchor source before
 * the rule runs is the truncated string, after it the full one. A rule that stopped transforming
 * anything would still satisfy the first and fail the second.
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
 * else the empty string — is what the plugin exploits.
 */
function anchorSource(token: FakeToken): string {
  if (token.children) return token.children.map(anchorSource).join('');
  if (token.type === 'text') return token.content;
  return '';
}

/** Runs the plugin's core rule over a token stream, the way markdown-it would. */
function applyRule(tokens: FakeToken[], times = 1): FakeToken[] {
  const rules: Array<(state: unknown) => void> = [];
  const md = {
    core: { ruler: { push: (_name: string, fn: (state: unknown) => void) => rules.push(fn) } },
  };
  keepInlineCodeInHeadingAnchors(md);
  expect(rules).toHaveLength(1);
  for (let i = 0; i < times; i++) rules[0]({ tokens, Token: FakeToken });
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
    const tokens = paragraph([text('Set '), codeSpan('approvals'), text(' in your config.')]);
    applyRule(tokens);

    expect(tokens[1].children![1].children).toBeNull();
    expect(anchorSource(tokens[1])).toBe('Set  in your config.');
  });

  it('leaves a heading with no code span alone', () => {
    const tokens = heading([text('Configuration')]);
    applyRule(tokens);

    expect(tokens[1].children!.map((child) => [child.type, child.content, child.children])).toEqual(
      [['text', 'Configuration', null]]
    );
  });

  it('is idempotent', () => {
    const tokens = heading([codeSpan('approvals')]);
    applyRule(tokens, 2);

    expect(tokens[1].children![0].children).toHaveLength(1);
    expect(anchorSource(tokens[1])).toBe('approvals');
  });

  it('is registered in typedoc.json and satisfies the plugin contract', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../../typedoc.json', import.meta.url), 'utf8')
    );
    expect(config.plugin).toContain('./scripts/typedoc-github-heading-anchors.mjs');
    expect(typeof load).toBe('function');
  });
});
