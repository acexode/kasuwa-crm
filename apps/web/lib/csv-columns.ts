/**
 * Column mapping on `P01/5.4`: read a spreadsheet's header row, guess which
 * Kasuwa field each column is, and leave the ones we cannot guess for the
 * person to choose — the design's "one field left to fix" state.
 *
 * Only the HEADER and a row count are read, in the browser. The rows
 * themselves are customer data and are not parsed, shown or kept here; the
 * importer (M20/M21) owns them.
 */

export const KASUWA_IMPORT_FIELDS = ['fullName', 'mobile', 'email', 'company', 'notes', 'skip'] as const;
export type KasuwaImportField = (typeof KASUWA_IMPORT_FIELDS)[number];

export interface CsvSummary {
  readonly columns: readonly string[];
  /** Data rows, excluding the header and blank lines. */
  readonly rows: number;
}

/** One CSV record's fields, honouring double-quoted fields and `""` escapes. */
function splitRecord(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quoted) {
      if (character === '"' && line.charAt(index + 1) === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  fields.push(current.trim());
  return fields;
}

export function summariseCsv(text: string): CsvSummary {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header = lines[0];
  if (header === undefined) return { columns: [], rows: 0 };
  return { columns: splitRecord(header).filter((column) => column !== ''), rows: lines.length - 1 };
}

const GUESSES: readonly [RegExp, KasuwaImportField][] = [
  [/e-?mail/i, 'email'],
  [/phone|mobile|msisdn|tel\b|whatsapp/i, 'mobile'],
  [/company|organi[sz]ation|business|employer/i, 'company'],
  [/note|comment/i, 'notes'],
  [/name/i, 'fullName'],
];

/** The field a column header most likely means, or `null` to leave it for the person. */
export function guessField(column: string): KasuwaImportField | null {
  for (const [pattern, field] of GUESSES) {
    if (pattern.test(column)) return field;
  }
  return null;
}
