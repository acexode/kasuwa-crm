import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRIES, PARTS_IN_FLIGHT, URL_LIFETIME_MS, ImportUploader, retryDelayMs, type UploadFailure, type UploadView } from './import-upload';
import { abortImportUpload, completeImportUpload, getImport, issueImportUploadUrls } from './imports-api';

vi.mock('./imports-api', () => ({
  abortImportUpload: vi.fn(),
  completeImportUpload: vi.fn(),
  getImport: vi.fn(),
  issueImportUploadUrls: vi.fn(),
}));

/** A stand-in for the browser's XMLHttpRequest that the test answers by hand. */
class FakeRequest {
  static all: FakeRequest[] = [];
  status = 0;
  url = '';
  aborted = false;
  dead = false;
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeRequest.all.push(this);
  }
  open(_method: string, url: string): void {
    this.url = url;
  }
  send(): void {}
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  getResponseHeader(): string | null {
    return `"etag-${this.url}"`;
  }
  fail(): void {
    this.dead = true;
    this.onerror?.();
  }
  answer(status: number): void {
    this.status = status;
    this.onload?.();
  }
}

const MIB = 1_048_576;
const part = (partNumber: number, sizeBytes: number, host = 'a') => ({ partNumber, url: `https://storage.example/${host}/${partNumber}`, sizeBytes });

function plan(sizes: readonly number[]) {
  return { importId: 'job-1', parts: sizes.map((size, index) => part(index + 1, size)), expiresAt: '2026-10-19T09:05:00Z' };
}

const job = { id: 'job-1', status: 'reading_header' } as never;

interface Harness {
  readonly uploader: ImportUploader;
  readonly views: UploadView[];
  readonly failures: UploadFailure[];
  readonly done: unknown[];
}

function start(sizes: readonly number[]): Harness {
  const views: UploadView[] = [];
  const failures: UploadFailure[] = [];
  const done: unknown[] = [];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const uploader = new ImportUploader(new File([new Uint8Array(total)], 'a.csv'), plan(sizes), (view) => views.push(view), (value) => done.push(value), (failure) => failures.push(failure));
  uploader.start();
  return { uploader, views, failures, done };
}

const open = () => FakeRequest.all.filter((request) => !request.aborted && !request.dead && request.status === 0);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  FakeRequest.all = [];
  vi.stubGlobal('XMLHttpRequest', FakeRequest);
  vi.mocked(completeImportUpload).mockResolvedValue({ ok: true, value: job });
  vi.mocked(abortImportUpload).mockResolvedValue({ ok: true, value: job });
  vi.mocked(getImport).mockResolvedValue({ ok: false, error: { code: 'network' } });
  vi.mocked(issueImportUploadUrls).mockImplementation((_id, numbers) =>
    Promise.resolve({ ok: true, value: { importId: 'job-1', parts: numbers.map((number) => part(number, MIB, 'fresh')), expiresAt: '2026-10-19T09:10:00Z' } }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the upload’s bounds', () => {
  it('sends two parts at a time and tries each part five times', () => {
    expect(PARTS_IN_FLIGHT).toBe(2);
    expect(MAX_TRIES).toBe(5);
  });

  it('waits longer after each failed try, never over eight seconds', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(retryDelayMs(20)).toBe(8000);
  });
});

describe('the uploader', () => {
  it('never has more than two parts open, and completes once with every ETag ascending', async () => {
    const { views, done } = start([MIB, MIB, MIB, MIB]);
    await flush();
    expect(open()).toHaveLength(2);
    open()[0]?.answer(200);
    await flush();
    expect(open()).toHaveLength(2);
    for (let round = 0; round < 3; round += 1) {
      for (const request of open()) request.answer(200);
      await flush();
    }
    expect(completeImportUpload).toHaveBeenCalledTimes(1);
    const parts = vi.mocked(completeImportUpload).mock.calls[0]?.[1] ?? [];
    expect(parts.map((entry) => entry.partNumber)).toEqual([1, 2, 3, 4]);
    expect(done).toHaveLength(1);
    expect(views.at(-1)).toMatchObject({ state: 'done', percent: 100 });
  });

  it('starts no new part while paused, and carries on the same upload when resumed', async () => {
    const { uploader, views } = start([MIB, MIB, MIB, MIB]);
    await flush();
    uploader.pause();
    expect(views.at(-1)?.state).toBe('paused');
    for (const request of open()) request.answer(200);
    await flush();
    expect(FakeRequest.all).toHaveLength(2);
    uploader.resume();
    await flush();
    expect(FakeRequest.all).toHaveLength(4);
    expect(abortImportUpload).not.toHaveBeenCalled();
  });

  it('re-issues an expired URL for the part that failed, never one that landed, and retries on the new URL', async () => {
    start([MIB, MIB]);
    await flush();
    const [first, second] = open();
    first?.answer(200);
    second?.answer(403);
    await flush();
    expect(issueImportUploadUrls).toHaveBeenCalledWith('job-1', [2]);
    expect(open()[0]?.url).toBe('https://storage.example/fresh/2');
  });

  it('gives up once, even when two parts fail together, and resumes from the parts still missing', async () => {
    const { uploader, failures, views } = start([MIB, MIB]);
    await flush();
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      for (const request of open()) request.fail();
      await vi.advanceTimersByTimeAsync(9_000);
    }
    expect(failures).toEqual([{ kind: 'parts' }]);
    expect(views.at(-1)?.state).toBe('failed');
    expect(completeImportUpload).not.toHaveBeenCalled();
    uploader.resume();
    await flush();
    expect(open()).toHaveLength(2);
  });

  it('gives a part fresh re-issues after a resume (N1)', async () => {
    const { uploader, failures } = start([MIB]);
    await flush();
    // Every URL is refused as expired until the part gives up on its re-issues.
    for (let round = 0; round < 6 && failures.length === 0; round += 1) {
      open()[0]?.answer(403);
      await flush();
    }
    expect(failures).toEqual([{ kind: 'parts' }]);
    const issued = vi.mocked(issueImportUploadUrls).mock.calls.length;
    uploader.resume();
    await flush();
    open()[0]?.answer(403);
    await flush();
    expect(vi.mocked(issueImportUploadUrls).mock.calls.length).toBe(issued + 1);
  });

  it('re-issues a URL before sending once the URLs are five minutes old (N1)', async () => {
    const { uploader } = start([MIB, MIB, MIB]);
    await flush();
    uploader.pause();
    for (const request of open()) request.answer(200);
    await flush();
    await vi.advanceTimersByTimeAsync(URL_LIFETIME_MS);
    uploader.resume();
    await flush();
    expect(issueImportUploadUrls).toHaveBeenCalledWith('job-1', [3]);
    expect(open()[0]?.url).toBe('https://storage.example/fresh/3');
  });

  it('reads the job when the answer to complete is lost, and carries on if it moved past the upload (N2)', async () => {
    vi.mocked(completeImportUpload).mockResolvedValue({ ok: false, error: { code: 'network' } });
    vi.mocked(getImport).mockResolvedValue({ ok: true, value: { id: 'job-1', status: 'reading_header' } as never });
    const { done, failures } = start([MIB]);
    await flush();
    open()[0]?.answer(200);
    await flush();
    expect(getImport).toHaveBeenCalledTimes(1);
    expect(done).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('stays retryable when the job is still awaiting its upload after a lost complete (N2)', async () => {
    vi.mocked(completeImportUpload).mockResolvedValueOnce({ ok: false, error: { code: 'network' } });
    vi.mocked(getImport).mockResolvedValue({ ok: true, value: { id: 'job-1', status: 'awaiting_upload' } as never });
    const { uploader, done, failures } = start([MIB]);
    await flush();
    open()[0]?.answer(200);
    await flush();
    expect(failures).toHaveLength(1);
    uploader.resume();
    await flush();
    expect(completeImportUpload).toHaveBeenCalledTimes(2);
    expect(done).toHaveLength(1);
  });

  it('cannot be cancelled while complete is in flight, and says so in its view (N3)', async () => {
    let finish: (value: { ok: true; value: never }) => void = () => undefined;
    vi.mocked(completeImportUpload).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { uploader, views } = start([MIB]);
    await flush();
    open()[0]?.answer(200);
    await flush();
    expect(views.at(-1)?.completing).toBe(true);
    await uploader.cancel();
    expect(abortImportUpload).not.toHaveBeenCalled();
    finish({ ok: true, value: job });
    await flush();
    expect(views.at(-1)).toMatchObject({ state: 'done', completing: false });
  });

  it('stops every part and aborts the upload once when cancelled, and stays quiet afterwards (B1)', async () => {
    const { uploader, views, failures } = start([MIB, MIB, MIB]);
    await flush();
    const before = views.length;
    await uploader.cancel();
    await uploader.cancel();
    expect(FakeRequest.all.filter((request) => request.aborted)).toHaveLength(2);
    expect(abortImportUpload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeRequest.all).toHaveLength(2);
    expect(views.length).toBe(before);
    expect(failures).toEqual([]);
    expect(completeImportUpload).not.toHaveBeenCalled();
  });

  it('does not abort an upload that already completed (B1)', async () => {
    const { uploader } = start([MIB]);
    await flush();
    open()[0]?.answer(200);
    await flush();
    await uploader.cancel();
    expect(abortImportUpload).not.toHaveBeenCalled();
  });
});
