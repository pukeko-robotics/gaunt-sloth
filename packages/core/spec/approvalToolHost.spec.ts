import { describe, expect, it } from 'vitest';
import { toolCallHosts } from '#src/core/approvals/toolHost.js';

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
    expect(toolCallHosts({ url: 'https://docs.internal.example/a' })).toEqual(
      toolCallHosts({ url: 'http://DOCS.internal.example/b' })
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

  it('stops descending past its depth budget, and finds the same host within it', () => {
    // Deeper than the walk goes.
    let deep: Record<string, unknown> = { url: 'https://buried.example/x' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(toolCallHosts(deep)).toEqual([]);

    // CONTROL: within the budget the very same host is found.
    expect(toolCallHosts({ a: { b: { url: 'https://buried.example/x' } } })).toEqual([
      'buried.example',
    ]);
  });

  /**
   * The value budget, asserted by what it **misses**. Two hosts are present and only the one inside
   * the budget is reported, so this fails the moment the budget stops biting — where a single
   * planted host could not tell a working budget from an absent one, the bound holding either way.
   *
   * It pins the budget's *effect*, not its value: it must be wide enough to reach an early argument
   * and narrow enough to give up before a five-thousandth one.
   */
  it('gives up part-way through a pathological argument object, so it finds fewer hosts than exist', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = `value ${i}`;
    wide.k10 = 'https://early.example/x';
    wide.k4000 = 'https://late.example/y';

    expect(toolCallHosts(wide)).toEqual(['early.example']);
    // CONTROL: the host it gave up before IS one this module recognizes — it is the budget that
    // hid it, not the value.
    expect(toolCallHosts({ k4000: wide.k4000 })).toEqual(['late.example']);
  });

  /**
   * The length cap, which is **not cosmetic**: an unrecognized value means no host, and no host
   * means the call takes the tool-only arm and gets the BROADER grant. So the cap has to be a
   * deliberate reading of "not something a grant should be keyed on", and it needs to be visible
   * when someone changes it.
   */
  it('does not read a host out of an absurdly long value — the broader-grant direction', () => {
    const overLong = `https://long.example/${'x'.repeat(20000)}`;
    expect(toolCallHosts({ url: overLong })).toEqual([]);
    // CONTROL: the identical host in an ordinary-length URL is found, so this is the length and
    // nothing else about the value.
    expect(toolCallHosts({ url: 'https://long.example/x' })).toEqual(['long.example']);
  });

  it('walks arguments that are not an object at all without inventing a host', () => {
    expect(toolCallHosts(undefined)).toEqual([]);
    expect(toolCallHosts(null)).toEqual([]);
    expect(toolCallHosts(42)).toEqual([]);
    // A bare string IS walked, so a tool whose whole argument is a URL still carries its host.
    expect(toolCallHosts('https://a.example/x')).toEqual(['a.example']);
  });
});
