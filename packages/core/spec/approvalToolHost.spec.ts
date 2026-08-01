import { describe, expect, it } from 'vitest';
import { toolCallHost, toolCallHosts } from '#src/core/approvals/toolHost.js';

/**
 * EXT-70 §4.7.4 — the host a tool call reaches, read off the call's own arguments.
 *
 * Every "this names no host" assertion here sits beside a positive one over the same shape, because
 * on an extractor that returns nothing at all the negatives pass in a body and the positives do not.
 */
describe('toolCallHosts — which counterparties a tool call names', () => {
  it('reads the host out of a URL argument, whatever the argument is called', () => {
    expect(toolCallHosts({ url: 'https://docs.internal.example/guide' })).toEqual([
      'docs.internal.example',
    ]);
    // The raw-string tool schema arrives wrapped, so the key is not something to key off.
    expect(toolCallHosts({ input: 'https://docs.internal.example/guide' })).toEqual([
      'docs.internal.example',
    ]);
  });

  it('drops the scheme, the port, the path and the case — a grant compares hosts by equality', () => {
    expect(toolCallHosts({ url: 'HTTPS://Docs.Internal.EXAMPLE:8443/a/b?q=1#f' })).toEqual([
      'docs.internal.example',
    ]);
    // …so two spellings of one host are one host, and the second call matches the first's grant.
    expect(toolCallHost({ url: 'https://docs.internal.example/a' })).toBe(
      toolCallHost({ url: 'http://DOCS.internal.example/b' })
    );
  });

  it('finds a host nested in an object or an array', () => {
    expect(toolCallHosts({ request: { target: 'https://a.example/x' } })).toEqual(['a.example']);
    expect(toolCallHosts({ urls: ['https://a.example/x'] })).toEqual(['a.example']);
  });

  /**
   * The schemes that name no counterparty fall out of the non-empty-`hostname` test rather than a
   * list — a list would need maintaining and would be wrong the first time a scheme was missed.
   * The control is the same walk over the same shape finding an http host.
   */
  it.each([
    ['a local path', '/etc/passwd'],
    ['a file URL', 'file:///etc/passwd'],
    ['a data URL', 'data:text/plain,hello'],
    ['a mail address', 'mailto:someone@example.com'],
    ['prose that merely mentions a host', 'see docs.internal.example for details'],
    ['a bare dotted name with no scheme', 'docs.internal.example/guide'],
  ])('names no host: %s', (_label, value) => {
    expect(toolCallHosts({ value })).toEqual([]);
    // CONTROL: the walk does reach this argument.
    expect(toolCallHosts({ value: 'https://a.example/x' })).toEqual(['a.example']);
  });

  it('reports each distinct host once, in the order first seen', () => {
    expect(
      toolCallHosts({
        from: 'https://a.example/x',
        to: 'https://b.example/y',
        also: 'https://a.example/z',
      })
    ).toEqual(['a.example', 'b.example']);
  });

  it('ignores inherited properties — only what the call actually carries', () => {
    const args = Object.create({ url: 'https://inherited.example/x' }) as Record<string, unknown>;
    args.note = 'nothing here';
    expect(toolCallHosts(args)).toEqual([]);
    // CONTROL: the same host as an OWN property is found.
    expect(toolCallHosts({ url: 'https://inherited.example/x' })).toEqual(['inherited.example']);
  });

  it('bounds its work on a pathological argument object rather than spinning', () => {
    // Deeper than the walk goes, and wider than its value budget.
    let deep: Record<string, unknown> = { url: 'https://buried.example/x' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(toolCallHosts(deep)).toEqual([]);

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = `value ${i}`;
    wide.url = 'https://late.example/x';
    expect(toolCallHosts(wide).length).toBeLessThanOrEqual(1);

    // CONTROL: within the budget the very same host is found.
    expect(toolCallHosts({ a: { b: { url: 'https://buried.example/x' } } })).toEqual([
      'buried.example',
    ]);
  });
});

describe('toolCallHost — the ONE host, or none', () => {
  it('answers with the single host a call names', () => {
    expect(toolCallHost({ url: 'https://a.example/x' })).toBe('a.example');
  });

  /**
   * Both ways of having no single host answer `undefined` here, and that is what makes the two
   * indistinguishable to the rule matcher — an entry naming a host must not match either. The
   * escalation menu needs to tell them apart and therefore reads `toolCallHosts`, which is asserted
   * end to end in the runner spec.
   */
  it('answers undefined for a call naming none, and for one naming several', () => {
    expect(toolCallHost({ note: 'nothing here' })).toBeUndefined();
    expect(
      toolCallHost({ from: 'https://a.example/x', to: 'https://b.example/y' })
    ).toBeUndefined();
    // CONTROL: one host of that very pair, alone, does answer.
    expect(toolCallHost({ from: 'https://a.example/x' })).toBe('a.example');
  });

  it('answers undefined for arguments that are not an object at all', () => {
    expect(toolCallHost(undefined)).toBeUndefined();
    expect(toolCallHost(null)).toBeUndefined();
    // A bare string IS walked, so a tool whose whole argument is a URL still carries its host.
    expect(toolCallHost('https://a.example/x')).toBe('a.example');
  });
});
