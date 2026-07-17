import { describe, expect, it } from 'vitest';

describe('parseOverFile', () => {
  describe('csv', () => {
    it('parses a header row + data rows into records', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.csv', 'name,city\nalice,paris\nbob,berlin\n');
      expect(rows).toEqual([
        { name: 'alice', city: 'paris' },
        { name: 'bob', city: 'berlin' },
      ]);
    });

    it('handles quoted fields containing commas and escaped quotes', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.csv', 'name,quote\n"Smith, John","She said ""hi"""\n');
      expect(rows).toEqual([{ name: 'Smith, John', quote: 'She said "hi"' }]);
    });

    it('skips blank lines', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.csv', 'name\nalice\n\nbob\n');
      expect(rows).toEqual([{ name: 'alice' }, { name: 'bob' }]);
    });

    it('throws on an empty file', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      expect(() => parseOverFile('cases.csv', '')).toThrow(/empty CSV/);
    });

    it('throws when a row has a different field count than the header', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      expect(() => parseOverFile('cases.csv', 'a,b\n1,2,3\n')).toThrow(/expected 2/);
    });

    it('throws when there is only a header row', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      expect(() => parseOverFile('cases.csv', 'a,b\n')).toThrow(/no data rows/);
    });
  });

  describe('jsonl', () => {
    it('parses one JSON object per line (.jsonl)', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.jsonl', '{"a":"1"}\n{"a":"2"}\n');
      expect(rows).toEqual([{ a: '1' }, { a: '2' }]);
    });

    it('parses .ndjson the same way', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.ndjson', '{"a":"1"}\n');
      expect(rows).toEqual([{ a: '1' }]);
    });

    it('stringifies non-string field values', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.jsonl', '{"n":42,"ok":true}\n');
      expect(rows).toEqual([{ n: '42', ok: 'true' }]);
    });

    it('skips blank lines', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      const rows = parseOverFile('cases.jsonl', '{"a":"1"}\n\n{"a":"2"}\n');
      expect(rows).toEqual([{ a: '1' }, { a: '2' }]);
    });

    it('throws with the offending line number on invalid JSON', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      expect(() => parseOverFile('cases.jsonl', '{"a":"1"}\nnot json\n')).toThrow(/line 2/);
    });

    it('throws when a line is a JSON array or scalar, not an object', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      expect(() => parseOverFile('cases.jsonl', '[1,2,3]\n')).toThrow(/must be a JSON object/);
    });

    it('throws on an empty file', async () => {
      const { parseOverFile } = await import('#src/parseOver.js');
      expect(() => parseOverFile('cases.jsonl', '')).toThrow(/no rows/);
    });
  });
});
