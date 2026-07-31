import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TUI-C33 — geometry tests for the interactive launch banner. Everything here goes through the
 * pure API, which is the point of the module: the column maths, the truncation budgets and the
 * colour split are all provable without a terminal, a config or a mounted renderer.
 */

/** Column at which the right-hand column starts on every row (TUI-C36 shifted it by the margin). */
const RIGHT = 22;
/** Column at which the version label starts on the second art row. */
const VERSION = 44;
/** Narrowest terminal that still gets the right column. */
const MIN_COLUMNS = 46;
/** Index of the first art row: row 0 is TUI-C36's blank padding row. */
const ART = 1;
/** The two escapes the colour split is built from (`ANSI_COLORS.magenta` / `.reset`). */
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

/** The rendered line's columns from `at` onwards, counted in characters rather than UTF-16 units. */
const columnsFrom = (line: string, at: number): string => [...line].slice(at).join('');

describe('core/launchBanner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('exposes the split columns the layout is expressed in', async () => {
    const { LEFT_PAD, RIGHT_COLUMN, VERSION_COLUMN, MIN_BANNER_COLUMNS } =
      await import('#src/core/launchBanner.js');
    expect(LEFT_PAD).toBe(1);
    expect(RIGHT_COLUMN).toBe(RIGHT);
    expect(VERSION_COLUMN).toBe(VERSION);
    expect(MIN_BANNER_COLUMNS).toBe(MIN_COLUMNS);
  });

  it('starts the right column at 22 on every art row and the version at 44', async () => {
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
    expect(rows).toHaveLength(7);
    // Every ART row's face half is padded to exactly the split column, so `right` begins at 22.
    for (const row of rows.slice(ART, ART + 5)) {
      expect([...row.face].length).toBe(RIGHT);
    }

    const lines = launchBannerText(input).split('\n');
    lines.forEach((line, index) => {
      // The rendered line is exactly face-then-right, so the right column begins at column 22
      // and the gutter column before it is blank on every art row.
      expect(columnsFrom(line, RIGHT)).toBe(rows[index].right);
      if (rows[index].right) expect([...line][RIGHT - 1]).toBe(' ');
    });
    // The version sits three columns past the 19-wide wordmark, i.e. at column 44.
    expect(columnsFrom(lines[ART + 1], VERSION)).toBe('v2.0.0-alpha.25');
    expect([...lines[ART + 1]][VERSION - 1]).toBe(' ');
    // The last two art rows carry the remaining fields, both flush at the split column.
    expect(columnsFrom(lines[ART + 3], RIGHT)).toBe('gemini-3.1-pro (google-genai)');
    expect(columnsFrom(lines[ART + 4], RIGHT)).toBe('~/dev/takahe');
  });

  it('pads the block: a blank row above and below, and a one-column left margin (TUI-C36)', async () => {
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
    // First and last rows are padding: empty on BOTH halves, so they carry no margin of their own
    // and cannot end in whitespace.
    expect(rows[0]).toEqual({ face: '', right: '' });
    expect(rows[6]).toEqual({ face: '', right: '' });
    // Every art row opens with the one-column margin, and no art row is blank.
    for (const row of rows.slice(ART, ART + 5)) {
      expect(row.face.startsWith(' ')).toBe(true);
      expect(row.face.trim()).not.toBe('');
    }
    // The margin is a real shift, not a re-indent of the art: the widest face row used to start at
    // column 0 and now starts at column 1.
    expect(rows[ART + 1].face.slice(0, 2)).toBe(' ▄');

    // …and on the text surface the padding rows are empty lines.
    const lines = launchBannerText(input).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('');
    expect(lines[6]).toBe('');
  });

  it('renders model and provider together, alone, or drops the line when neither resolves', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const modelRow = (input: { model?: string; provider?: string }): string =>
      launchBannerRows({ ...input, columns: 120 })[ART + 3].right;

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
    expect(launchBannerRows({ columns: 120 })[ART + 1].right).toBe('┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓');
  });

  it('truncates an over-long model id to the remaining width, keeping the head', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const model = 'some-absurdly-long-model-identifier-from-a-router';
    const columns = 50;
    const right = launchBannerRows({ model, columns })[ART + 3].right;

    expect([...right].length).toBe(columns - RIGHT);
    expect(right.endsWith('…')).toBe(true);
    expect(right.startsWith('some-absurdly-long')).toBe(true);
    // The whole line still fits the terminal, which is the only reason this matters: a wrapped
    // continuation would restart at column 0 and collide with the face.
    expect([...(launchBannerRows({ model, columns })[ART + 3].face + right)].length).toBe(columns);
  });

  it('truncates a deep directory from the LEFT, keeping the leaf', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const columns = 50;
    const right = launchBannerRows({
      directory: '/home/mari/dev/takahe/_worktrees/TUI-C33/gaunt-sloth',
      columns,
    })[ART + 4].right;

    expect([...right].length).toBe(columns - RIGHT);
    expect(right.startsWith('…')).toBe(true);
    expect(right.endsWith('gaunt-sloth')).toBe(true);
  });

  it('DROPS a version that does not fit its column-44 budget, rather than truncating it', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const version = '2.0.0-alpha.25'; // `v2.0.0-alpha.25` — 15 columns with the prefix
    const bare = '┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓';
    const row = (columns: number): string => launchBannerRows({ version, columns })[ART + 1].right;

    // 55 columns leaves 11 for the label. A truncated `v2.0.0-alp…` would read as a real,
    // different version, so the label goes entirely and the row is the bare wordmark.
    expect(row(55)).toBe(bare);
    expect(row(55)).not.toContain('…');
    // Exactly enough (44 + 15) shows it in full; one column less drops it. Off-by-one either way
    // would either clip the version or hide one that fits.
    expect(row(VERSION + 15)).toBe(`${bare}   v${version}`);
    expect(row(VERSION + 14)).toBe(bare);
    // At the narrowest banner there are 2 columns for the label — likewise nothing at all.
    expect(row(MIN_COLUMNS)).toBe(bare);
  });

  it('still truncates the model and directory, which are terse rather than misleading when clipped', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    // The same narrowest terminal that drops the version keeps both other fields, truncated.
    const rows = launchBannerRows({
      version: '2.0.0-alpha.25',
      model: 'some-absurdly-long-model-identifier',
      directory: '/home/mari/dev/takahe/packages/core',
      homeDir: '/home/mari',
      columns: MIN_COLUMNS,
    });
    expect(rows[ART + 1].right).toBe('┃┓┏┓┓┏┏┓╋  ┗┓┃┏┓╋┣┓'); // version dropped
    expect(rows[ART + 3].right).toBe('some-absurdly-long-mode…'); // 46 - 22 = 24 columns, tail lost
    expect(rows[ART + 4].right).toBe('…ev/takahe/packages/core'); // 24 columns, head lost
  });

  it('drops the right column entirely below the narrowest banner width', async () => {
    const { launchBannerRows, launchBannerText } = await import('#src/core/launchBanner.js');
    const input = {
      version: '2.0.0',
      model: 'gpt-5',
      provider: 'openai',
      directory: '/home/mari/dev',
      homeDir: '/home/mari',
      columns: MIN_COLUMNS - 1,
    };

    const rows = launchBannerRows(input);
    expect(rows.map((r) => r.right)).toEqual(['', '', '', '', '', '', '']);
    // The face prints alone — no wordmark rubble, no trailing whitespace — but it keeps the left
    // margin and the blank rows, because the padding is not a function of the width.
    expect(launchBannerText(input).split('\n')).toEqual([
      '',
      '   ▄█▀▀▀▀▀▀▀▀█▄',
      ' ▄▀█▄█▀▀▀▀▀▀█▄█▀▄',
      ' █  ▀█▄▀  ▀▄█▀  █',
      ' ▀▄▀▀ ██████ ▀▀▄▀',
      '   ▀██████████▀',
      '',
    ]);
  });

  it('falls back to 80 columns when the width is unknown or non-finite', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const model = 'x'.repeat(200);
    const budget = 80 - RIGHT;

    for (const columns of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rows = launchBannerRows({ model, columns });
      expect([...rows[ART + 3].right].length).toBe(budget);
    }
  });

  it('collapses the home prefix to ~ only on a path boundary, on both separators', async () => {
    const { launchBannerRows } = await import('#src/core/launchBanner.js');
    const dir = (directory: string, homeDir: string): string =>
      launchBannerRows({ directory, homeDir, columns: 200 })[ART + 4].right;

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
    const { launchBannerRows, launchBannerText } = await import('#src/core/launchBanner.js');
    const input = {
      version: '2.0.0',
      model: 'gpt-5',
      directory: '/home/mari',
      homeDir: '/home/mari',
      columns: 120,
      colour: true,
    };
    const rows = launchBannerRows(input);
    const lines = launchBannerText(input).split('\n');

    // The two TUI-C36 padding rows carry no glyph, so they carry no escape either — an empty line
    // wrapped in a magenta/reset pair is two escapes painting nothing.
    expect(lines[0]).toBe('');
    expect(lines[lines.length - 1]).toBe('');

    lines.slice(ART, ART + 5).forEach((line, offset) => {
      const index = ART + offset;
      const { right } = rows[index];
      // Exactly one magenta..reset pair per row…
      expect(line.startsWith(MAGENTA)).toBe(true);
      expect(line.match(/\x1b\[35m/g)).toHaveLength(1);
      expect(line.match(/\x1b\[0m/g)).toHaveLength(1);
      // …and — the assertion that actually bites — it CLOSES AT COLUMN 21. Counting the pair is
      // not enough: wrapping the whole row (`magenta + face + right + reset`) also yields one
      // pair with nothing after the reset, while painting the right column magenta too.
      expect(line.indexOf(RESET)).toBe(MAGENTA.length + RIGHT);
      // Everything past the reset is this row's right column, verbatim and unpainted.
      expect(line.slice(line.indexOf(RESET) + RESET.length)).toBe(right);
      expect(right).not.toBe(''); // every row of this input has right-hand content to protect
    });
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
