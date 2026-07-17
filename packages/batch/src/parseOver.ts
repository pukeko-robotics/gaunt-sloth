import type { MatrixRow } from '#src/types.js';

/**
 * Parse `--over <path>` content into matrix rows. Format is chosen by file extension:
 * `.jsonl`/`.ndjson` → one JSON object per line; anything else (including `.csv`) → CSV.
 *
 * This is content binding only (BATCH-1 scope): every row becomes an object of string fields that
 * {@link bindCellContent} interpolates into the script. A glob-of-binary-files path binding is out
 * of scope for this task.
 *
 * Throws a descriptive `Error` on malformed input — the harness-level failure the CLI surface doc
 * calls out as the one thing that should make `gth batch` exit non-zero (a bad row/cell answer
 * never should).
 */
export function parseOverFile(filePath: string, content: string): MatrixRow[] {
  const isJsonl = /\.(jsonl|ndjson)$/i.test(filePath);
  return isJsonl ? parseJsonl(filePath, content) : parseCsv(filePath, content);
}

function parseJsonl(filePath: string, content: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `--over ${filePath}: invalid JSON on line ${i + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `--over ${filePath}: line ${i + 1} must be a JSON object, got ${JSON.stringify(parsed)}`
      );
    }
    rows.push(stringifyRowValues(parsed as Record<string, unknown>));
  }
  if (rows.length === 0) {
    throw new Error(`--over ${filePath}: no rows found (empty JSONL file)`);
  }
  return rows;
}

function stringifyRowValues(record: Record<string, unknown>): MatrixRow {
  const row: MatrixRow = {};
  for (const [key, value] of Object.entries(record)) {
    row[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return row;
}

/** Minimal RFC4180 CSV parser (quoted fields, escaped `""`, CRLF/LF), header row = field names. */
function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsv(filePath: string, content: string): MatrixRow[] {
  const raw = parseCsvLines(content);
  if (raw.length === 0) {
    throw new Error(`--over ${filePath}: empty CSV file (no header row)`);
  }

  const header = raw[0].map((h) => h.trim());
  if (header.length === 0 || header.every((h) => h.length === 0)) {
    throw new Error(`--over ${filePath}: CSV header row is empty`);
  }

  const rows = raw
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      if (r.length !== header.length) {
        throw new Error(
          `--over ${filePath}: row has ${r.length} field(s), expected ${header.length} to match the header`
        );
      }
      return Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])) as MatrixRow;
    });

  if (rows.length === 0) {
    throw new Error(`--over ${filePath}: no data rows found (only a header row)`);
  }
  return rows;
}
