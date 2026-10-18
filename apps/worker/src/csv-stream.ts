import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { IMPORT_LIMITS } from '@kasuwa/domain-core';
import { parse } from 'csv-parse';

/**
 * Streaming CSV for the import worker (T-0094; D-L167 liveness N1-N3).
 *
 *   - Every read is a `stream.pipeline`, so an error in the source (a reset
 *     connection to the bucket) or in the parser REJECTS; nothing waits on a
 *     stream that will never end.
 *   - No record over 64 KiB is ever buffered. csv-parse cannot carry on past
 *     a record it refuses for size (observed: after CSV_MAX_RECORD_SIZE it
 *     parses nothing more, even with skip_records_with_error), yet R11 needs
 *     the rows after an oversized one. So `RecordSizeGuard` runs in front of
 *     it: it tracks only RFC 4180 record boundaries (quote state, and the LF,
 *     CRLF or bare CR that ends a record outside quotes), passes records of at
 *     most 64 KiB through untouched, and replaces a longer one with a one-cell
 *     placeholder record, discarding its bytes as they arrive. The parser's
 *     own `max_record_size` stays at 64 KiB as a backstop, and a
 *     CSV_MAX_RECORD_SIZE that still reaches it is a `row_too_large`.
 *   - Nothing here logs, and no error leaves with the parser's message (it
 *     can quote the row): callers get `CsvStreamError` with a fixed message.
 */

/** The record that stands in for one over the size cap. It cannot collide with a real record that is not an error anyway. */
export const OVERSIZE_PLACEHOLDER = '\u0000kasuwa:row_too_large\u0000';

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

export class RecordSizeGuard extends Transform {
  readonly #max: number;
  #record: Buffer[] = [];
  #size = 0;
  #inQuotes = false;
  #discarding = false;
  #pendingCr = false;

  constructor(maxRecordBytes: number = IMPORT_LIMITS.maxRowBytes) {
    super();
    this.#max = maxRecordBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i];
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (byte === LF) {
          // CRLF: the CR already ended the record; keep the LF with it.
          this.#append(chunk.subarray(start, i + 1));
          this.#endRecord();
          start = i + 1;
          continue;
        }
        this.#endRecord();
      }
      if (byte === QUOTE) {
        this.#inQuotes = !this.#inQuotes;
      } else if (!this.#inQuotes && byte === LF) {
        this.#append(chunk.subarray(start, i + 1));
        this.#endRecord();
        start = i + 1;
      } else if (!this.#inQuotes && byte === CR) {
        this.#append(chunk.subarray(start, i + 1));
        start = i + 1;
        this.#pendingCr = true;
      }
    }
    this.#append(chunk.subarray(start));
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.#pendingCr = false;
    if (this.#size > 0 || this.#discarding) this.#endRecord();
    callback();
  }

  #append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.#discarding) return;
    this.#size += part.length;
    if (this.#size > this.#max + 2) {
      // Over the cap (allowing for the record's own line ending): drop it.
      this.#record = [];
      this.#discarding = true;
      return;
    }
    this.#record.push(Buffer.from(part));
  }

  #endRecord(): void {
    if (this.#discarding) {
      this.push(Buffer.from(`${OVERSIZE_PLACEHOLDER}\n`, 'utf8'));
    } else if (this.#record.length > 0) {
      this.push(Buffer.concat(this.#record));
    }
    this.#record = [];
    this.#size = 0;
    this.#discarding = false;
    this.#inQuotes = false;
  }
}

export type CsvStreamFailure = 'source' | 'malformed';

/** A read that failed: where (the bytes or the CSV), and a fixed message. */
export class CsvStreamError extends Error {
  readonly failure: CsvStreamFailure;
  /** Data records already handed to the callback before the failure. */
  readonly recordsRead: number;

  constructor(failure: CsvStreamFailure, recordsRead: number) {
    super(failure === 'source' ? 'the import file could not be read' : 'the import file is not valid CSV');
    this.name = 'CsvStreamError';
    this.failure = failure;
    this.recordsRead = recordsRead;
  }
}

export interface CsvRecord {
  readonly cells: readonly string[];
  /** Over 64 KiB (replaced by the guard) or over the column cap: a whole-row error. */
  readonly tooLarge: boolean;
}

function parser() {
  return parse({
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
    max_record_size: IMPORT_LIMITS.maxRowBytes,
  });
}

function isCsvError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('CSV_');
}

/**
 * Hands every record (the header included, as record 0) to `onRecord`, in
 * order, awaiting each. `onRecord` answers 'stop' to end the read early.
 * Resolves when the file ends or a callback stops it; rejects with
 * CsvStreamError when the source or the CSV fails, and rethrows whatever a
 * callback throws.
 */
export async function forEachCsvRecord(
  stream: AsyncIterable<Uint8Array>,
  onRecord: (record: CsvRecord, index: number) => Promise<'continue' | 'stop'>,
): Promise<void> {
  let index = 0;
  let stopped = false;
  let callbackError: unknown = null;
  let oversizeAtParser = false;
  try {
    await pipeline(Readable.from(stream), new RecordSizeGuard(), parser(), async (records: AsyncIterable<string[]>) => {
      for await (const cells of records) {
        const placeholder = cells.length === 1 && cells[0] === OVERSIZE_PLACEHOLDER;
        const record: CsvRecord = {
          cells: placeholder ? [] : cells,
          tooLarge: placeholder || cells.length > IMPORT_LIMITS.maxColumns,
        };
        let next: 'continue' | 'stop';
        try {
          next = await onRecord(record, index);
        } catch (error) {
          callbackError = error;
          stopped = true;
          return;
        }
        index += 1;
        if (next === 'stop') {
          stopped = true;
          return;
        }
      }
    });
  } catch (error) {
    if (callbackError !== null) throw callbackError;
    if (stopped) return; // our own early return aborts the pipeline
    if ((error as { code?: unknown } | null)?.code === 'CSV_MAX_RECORD_SIZE') oversizeAtParser = true;
    if (oversizeAtParser) {
      // The guard should make this unreachable; it stays a row error, the end of the read.
      await onRecord({ cells: [], tooLarge: true }, index);
      return;
    }
    throw new CsvStreamError(isCsvError(error) ? 'malformed' : 'source', Math.max(0, index - 1));
  }
  if (callbackError !== null) throw callbackError;
}

/**
 * The first record only (the header row), or null when there is none or the
 * read fails. Stops reading the file as soon as it has it.
 */
export async function readFirstCsvRecord(stream: AsyncIterable<Uint8Array>): Promise<CsvRecord | null> {
  let first: CsvRecord | null = null;
  try {
    await forEachCsvRecord(stream, async (record) => {
      first = record;
      return 'stop';
    });
  } catch {
    return null;
  }
  return first;
}
