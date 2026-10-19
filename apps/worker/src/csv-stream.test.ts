import { describe, expect, it } from 'vitest';
import { CsvStreamError, forEachCsvRecord, readFirstCsvRecord, type CsvRecord } from './csv-stream';
import { readHeaderRow } from './import-jobs';

async function* chunks(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += size) yield new Uint8Array(bytes.subarray(i, i + size));
}

async function* failingAfter(text: string): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(Buffer.from(text, 'utf8'));
  throw new Error('connection reset by zqcell peer');
}

async function all(stream: AsyncIterable<Uint8Array>): Promise<CsvRecord[]> {
  const out: CsvRecord[] = [];
  await forEachCsvRecord(stream, async (record) => {
    out.push(record);
    return 'continue';
  });
  return out;
}

describe('forEachCsvRecord (D-L167 N1-N3)', () => {
  it('passes records through in order, across chunk boundaries, quoted newlines and CRLF', async () => {
    const records = await all(chunks('﻿Name,Notes\r\nada,"two\nlines"\r\nobi,x\r\n'));
    expect(records.map((r) => r.cells)).toEqual([
      ['Name', 'Notes'],
      ['ada', 'two\nlines'],
      ['obi', 'x'],
    ]);
  });

  it('replaces a record over 64 KiB with one row_too_large record, and reads every row after it (R11)', async () => {
    const big = 'b'.repeat(70_000);
    const records = await all(chunks(`Name,Blob\nr2,${'a'.repeat(60_000)}\nr3,"${big}\n${big}"\nr4,c\n`, 4096));
    expect(records.map((r) => [r.cells[0] ?? null, r.tooLarge])).toEqual([
      ['Name', false],
      ['r2', false],
      [null, true],
      ['r4', false],
    ]);
  });

  it('marks a record over the column cap as too large', async () => {
    const records = await all(chunks(`a\n${Array.from({ length: 501 }, () => 'x').join(',')}\n`, 1024));
    expect(records[1]?.tooLarge).toBe(true);
  });

  it('a source that fails mid-stream REJECTS with a fixed error, never hangs, never quotes the cause', async () => {
    const seen: string[][] = [];
    const error = await forEachCsvRecord(failingAfter('Name\nada\nobi,par'), async (record) => {
      seen.push([...record.cells]);
      return 'continue';
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CsvStreamError);
    expect((error as CsvStreamError).failure).toBe('source');
    expect(String((error as Error).message)).not.toContain('zqcell');
  });

  it('a malformed file rejects as malformed', async () => {
    const error = await all(chunks('Name\n"unterminated\n')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CsvStreamError);
    expect((error as CsvStreamError).failure).toBe('malformed');
  });

  it('stops early when the callback says so, and rethrows what a callback throws', async () => {
    let calls = 0;
    await forEachCsvRecord(chunks('a\nb\nc\nd\n'), async () => {
      calls += 1;
      return calls === 2 ? 'stop' : 'continue';
    });
    expect(calls).toBe(2);
    await expect(
      forEachCsvRecord(chunks('a\nb\n'), async () => {
        throw new Error('callback');
      }),
    ).rejects.toThrow('callback');
  });

  it('readFirstCsvRecord and readHeaderRow resolve null on a failing source', async () => {
    expect(await readFirstCsvRecord(failingAfter('Name,Ema'))).toBeNull();
    expect(await readHeaderRow(failingAfter('Name,Ema'))).toBeNull();
  });
});
