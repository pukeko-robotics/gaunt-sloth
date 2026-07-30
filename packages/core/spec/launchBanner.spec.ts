import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TUI-C33 — geometry tests for the interactive launch banner. Everything here goes through the
 * pure API, which is the point of the module: the column maths, the truncation budgets and the
 * colour split are all provable without a terminal, a config or a mounted renderer.
 */

/** Column at which the right-hand column starts on every row. */
const RIGHT = 21;
/** Column at which the version label starts on row 2. */
const VERSION = 43;

/** The rendered line's columns from `at` onwards, counted in characters rather than UTF-16 units. */
const columnsFrom = (line: string, at: number): string => [...line].slice(at).join('');

describe('core/launchBanner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('exposes the split columns the layout is expressed in', async () => {
    const { RIGHT_COLUMN, VERSION_COLUMN, MIN_BANNER_COLUMNS } =
      await import('#src/core/launchBanner.js');
    expect(RIGHT_COLUMN).toBe(RIGHT);
    expect(VERSION_COLUMN).toBe(VERSION);
    expect(MIN_BANNER_COLUMNS).toBe(45);
  });

  it('starts the right column at 21 on every row and the version at 43', async () => {
    const { launchBannerRows, launchBannerText } = await import('#src/core/launchBanner.js');
    const input = {
      version: '2.0.0-alpha.25',
      model: 'gemini-3.1-pro',
      provider: 'google-genai',
      directory: '/home/mari/dev/takahe',
      homeDir: '/home/mari',
      columns: 120,
    };

    const rows = launchBannerRows(input);
    expect(rows).toHaveLength(5);
    // Every row's face half is padded to exactly the split column, so `right` begins at 21.
    for (const row of rows) {
      expect([...row.face].length).toBe(RIGHT);
    }

    const lines = launchBannerText(input).split('\n');
    lines.forEach((line, index) => {
      // The rendered line is exactly face-then-right, so the right column begins at column 21
      // and the gutter column before it is blank on every row.
      expect(columnsFrom(line, RIGHT)).toBe(rows[index].right);
      expect([...line][RIGHT - 1]).toBe(' ');
    });
    // The version sits three columns past the 19-wide wordmark, i.e. at column 43.
    expect(columnsFrom(lines[1], VERSION)).toBe('v2.0.0-alpha.25');
    expect([...lines[1]][VERSION - 1]).toBe(' ');
    // Rows 4 and 5 carry the two remaining fields, both flush at the split column.
    expect(columnsFrom(lines[3], RIGHT)).toBe('gemini-3.1-pro (google-genai)');
    expect(columnsFrom(lines[4], RIGHT)).toBe('~/dev/takahe');
  });

  it('renders model and provider together, alone, or drops the line when neither resolves', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const modelRow = (input: { model?: string; provider?: string }): string =>
      launchBannerRows({ ...input, columns: 120 })[3].right;

    expect(modelRow({ model: 'gpt-5', provider: 'openai' })).toBe('gpt-5 (openai)');
    expect(modelRow({ model: 'gpt-5' })).toBe('gpt-5');
    expect(modelRow({ provider: 'openai' })).toBe('openai');
    // Never an empty pair of parentheses — the whole line goes.
    expect(modelRow({})).toBe('');
    expect(modelRow({ model: '  ', provider: '' })).toBe('');
  });

  it('omits the version label when no version resolves', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    // Row 2 is then the bare wordmark line, with nothing trailing it.
    expect(launchBannerRows({ columns: 120 })[1].right).toBe('┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓');
  });

  it('truncates an over-long model id to the remaining width, keeping the head', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const model = 'some-absurdly-long-model-identifier-from-a-router';
    const columns = 50;
    const right = launchBannerRows({ model, columns })[3].right;

    expect([...right].length).toBe(columns - RIGHT);
    expect(right.endsWith('…')).toBe(true);
    expect(right.startsWith('some-absurdly-long')).toBe(true);
    // The whole line still fits the terminal, which is the only reason this matters: a wrapped
    // continuation would restart at column 0 and collide with the face.
    expect([...(launchBannerRows({ model, columns })[3].face + right)].length).toBe(columns);
  });

  it('truncates a deep directory from the LEFT, keeping the leaf', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const columns = 50;
    const right = launchBannerRows({
      directory: '/home/mari/dev/takahe/_worktrees/TUI-C33/gaunt-sloth',
      columns,
    })[4].right;

    expect([...right].length).toBe(columns - RIGHT);
    expect(right.startsWith('…')).toBe(true);
    expect(right.endsWith('gaunt-sloth')).toBe(true);
  });

  it('truncates the version against its own column-43 budget', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    // 55 columns leaves 12 for the label, so `v2.0.0-alpha.25` (15) loses its tail.
    const right = launchBannerRows({ version: '2.0.0-alpha.25', columns: 55 })[1].right;
    expect(right.slice(-12)).toBe('v2.0.0-alph…');
    expect([...right].length).toBe(55 - RIGHT);
  });

  it('drops a field entirely when truncation would leave only the marker', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    // At 45 columns the version has 2 columns to live in; `v…` is all marker and no information.
    const rows = launchBannerRows({ version: '2.0.0-alpha.25', model: 'm', columns: 45 });
    expect(rows[1].right).toBe('┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓');
    // A field that FITS is not subject to that floor.
    expect(rows[3].right).toBe('m');
  });

  it('drops the right column entirely below 45 columns', async () => {
    const { launchBannerRows, launchBannerText } = await import('#src/core/launchBanner.js');
    const input = {
      version: '2.0.0',
      model: 'gpt-5',
      provider: 'openai',
      directory: '/home/mari/dev',
      homeDir: '/home/mari',
      columns: 44,
    };

    const rows = launchBannerRows(input);
    expect(rows.map((r) => r.right)).toEqual(['', '', '', '', '']);
    // The face prints alone and unpadded — no wordmark rubble, no trailing whitespace.
    expect(launchBannerText(input).split('\n')).toEqual([
      '  ▄█▀▀▀▀▀▀▀▀█▄',
      '▄▀█▄█▀▀▀▀▀▀█▄█▀▄',
      '█  ▀█▄▀  ▀▄█▀  █',
      '▀▄▀▀ ██████ ▀▀▄▀',
      '  ▀██████████▀',
    ]);
  });

  it('falls back to 80 columns when the width is unknown or non-finite', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const model = 'x'.repeat(200);
    const budget = 80 - RIGHT;

    for (const columns of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rows = launchBannerRows({ model, columns });
      expect([...rows[3].right].length).toBe(budget);
    }
  });

  it('collapses the home prefix to ~ only on a path boundary, on both separators', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const dir = (directory: string, homeDir: string): string =>
      launchBannerRows({ directory, homeDir, columns: 200 })[4].right;

    expect(dir('/home/mari/dev/takahe', '/home/mari')).toBe('~/dev/takahe');
    expect(dir('/home/mari', '/home/mari')).toBe('~');
    // Windows: homedir() reads %USERPROFILE% and the path is back-slashed.
    expect(dir('C:\\Users\\mari\\dev', 'C:\\Users\\mari')).toBe('~\\dev');
    // A sibling that merely shares the prefix must NOT be collapsed.
    expect(dir('/home/maria/dev', '/home/mari')).toBe('/home/maria/dev');
    // No home known ⇒ the path is reported as-is.
    expect(dir('/home/mari/dev', '')).toBe('/home/mari/dev');
  });

  it('paints the face magenta and leaves the right column uncoloured', async () => {
    const { launchBannerText } = await import('#src/core/launchBanner.js');
    const lines = launchBannerText({
      version: '2.0.0',
      model: 'gpt-5',
      directory: '/home/mari',
      homeDir: '/home/mari',
      columns: 120,
      colour: true,
    }).split('\n');

    for (const line of lines) {
      // Exactly one magenta..reset pair per row, and it closes before the right column starts.
      expect(line.startsWith('\x1b[35m')).toBe(true);
      expect(line.match(/\x1b\[35m/g)).toHaveLength(1);
      expect(line.match(/\x1b\[0m/g)).toHaveLength(1);
      expect(line.slice(line.indexOf('\x1b[0m') + '\x1b[0m'.length)).not.toContain('\x1b');
    }
    // The colour slot is the shared 16-colour magenta, never a 256-colour/24-bit escape.
    expect(lines.join('\n')).not.toMatch(/\x1b\[[34]8;/);
  });

  it('emits zero escape sequences when colour is off', async () => {
    const { launchBannerText } = await import('#src/core/launchBanner.js');
    const text = launchBannerText({
      version: '2.0.0',
      model: 'gpt-5',
      provider: 'openai',
      directory: '/home/mari/dev',
      homeDir: '/home/mari',
      columns: 120,
    });
    expect(text).not.toContain('\x1b');
    // …and the same holds on the narrow-terminal path.
    expect(launchBannerText({ version: '2.0.0', columns: 20 })).not.toContain('\x1b');
  });

  it('never leaves trailing whitespace on a row whose field was omitted', async () => {
    const { launchBannerText } = await import('#src/core/launchBanner.js');
    // No model and no directory ⇒ rows 4 and 5 are the bare face.
    for (const line of launchBannerText({ version: '2.0.0', columns: 120 }).split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''));
    }
  });

  it('resolves the live fields fail-soft, dropping the version when no install dir is set', async () => {
    const { launchBannerFields } = await import('#src/core/launchBanner.js');
    const { getProjectDir } = await import('#src/utils/systemUtils.js');

    // getSlothVersion() throws without an install dir (nothing calls setEntryPoint under test);
    // that must degrade to "no version label", never to a failed session start.
    const fields = launchBannerFields('gpt-5', 'openai');
    expect(fields.version).toBeUndefined();
    expect(fields.model).toBe('gpt-5');
    expect(fields.provider).toBe('openai');
    expect(fields.directory).toBe(getProjectDir());
    expect(fields.homeDir).toBeTruthy();
  });
});
