import { Application } from 'typedoc';

/**
 * Makes TypeDoc slug a markdown heading the way GitHub does when the heading carries an inline
 * code span.
 *
 * TypeDoc builds a heading's anchor from that heading's *text* tokens only: `getTokenTextContent`
 * walks `token.children` and returns `content` for `text` tokens, so a `code_inline` token — which
 * carries its text in `content` and has no children — contributes the empty string. GitHub keeps
 * that text. `The ladder: \`approvals\`` therefore anchors as `the-ladder` on the generated site
 * and `the-ladder-approvals` on GitHub, and a heading that is a bare inline-code word anchors as
 * `_`. Every page under `docs/` is read on both surfaces, so a link written against either slug is
 * reported broken by the other, and the anchor cannot be repaired from the link side.
 *
 * `docs/DOC-STYLE.md` makes GitHub's slug the authoritative one — it is what inbound links from
 * outside this repo already use, and renaming a heading to dodge the divergence breaks all of them
 * at once. This closes the gap from the renderer side instead.
 *
 * The mechanism: markdown-it renders `code_inline` from `token.content` and never looks at
 * `token.children`, so attaching a synthetic `text` child carrying the same string feeds the code
 * text to the anchor generator while leaving the rendered HTML byte-identical. Scoped to tokens
 * between a `heading_open` and its inline token, so code spans in body text are untouched.
 */
export function keepInlineCodeInHeadingAnchors(md) {
  md.core.ruler.push('gth-inline-code-heading-anchors', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      if (inline.type !== 'inline' || !inline.children) continue;
      for (const child of inline.children) {
        if (child.type !== 'code_inline' || child.children) continue;
        const text = new state.Token('text', '', 0);
        text.content = child.content;
        child.children = [text];
      }
    }
  });
}

/**
 * `markdownItLoader` only accepts a function, so it cannot be set from `typedoc.json` and has to
 * arrive through a plugin. Options are reset once more after plugins load, which is why this waits
 * for the bootstrap to finish, and it composes with whatever loader is already configured rather
 * than replacing it.
 */
export function load(app) {
  app.on(Application.EVENT_BOOTSTRAP_END, () => {
    const inherited = app.options.getValue('markdownItLoader');
    app.options.setValue('markdownItLoader', (md) => {
      inherited(md);
      keepInlineCodeInHeadingAnchors(md);
    });
  });
}
