import type { RecordsError } from './records-api';
import {
  abortImportUpload,
  completeImportUpload,
  getImport,
  issueImportUploadUrls,
  type ImportJob,
  type ImportUpload,
  type UploadPart,
} from './imports-api';

/**
 * The browser-direct multipart upload of one CSV (T-0096, I3).
 *
 * ---------------------------------------------------------------------------
 * THE PAGE NEVER READS THE FILE (I4, D-P21). A part is `file.slice(a, b)` handed
 * to the network as it is: no `FileReader`, no `text()`, no parse and no
 * preview, so no cell is ever held by the page. Nothing is written to the
 * device either: the `File` lives in memory, in this object, and a reload
 * starts the upload over.
 *
 * THE BUCKET GETS NOTHING OF THE SESSION. A part is PUT to the URL the API
 * issued, exactly as issued, with no header set at all (a signed URL is the
 * only credential), no cookie (a cross-origin request carries none without
 * `withCredentials`) and no referrer logging here. No URL is ever logged,
 * shown, stored or put in the address bar.
 *
 * TWO PARTS AT A TIME, FIVE TRIES EACH. A failed part is sent again after a
 * growing pause; a `403` is an expired URL, which is re-issued for the parts
 * still to upload (never one that already landed) and does not start the
 * upload over. A part that keeps failing ends the upload as `failed`, which
 * `resume()` picks up again from the parts still missing. `pause()` starts no
 * new part (one in flight finishes); `complete` is sent once, every part
 * ascending with the store's ETags.
 * ---------------------------------------------------------------------------
 */

/** Never more than this many PUTs open at once. */
export const PARTS_IN_FLIGHT = 2;
/** Tries per part, the first included. */
export const MAX_TRIES = 5;
/** URL re-issues per part, so a store that always answers 403 cannot loop. */
const MAX_REISSUES = 3;
/** Re-issue this long before a URL's five minutes are up, so a part never starts on a dying one. */
const EXPIRY_MARGIN_MS = 30_000;
/** A signed part URL lives five minutes (createImport). */
export const URL_LIFETIME_MS = 300_000;

export type UploadState = 'uploading' | 'paused' | 'done' | 'failed';

export interface UploadView {
  readonly state: UploadState;
  /** 0 to 100; 100 only once the upload was completed. */
  readonly percent: number;
  /** The completion is in flight: there is nothing left to cancel (N3). */
  readonly completing: boolean;
}

/** Why an upload stopped: a part gave up, or the API refused or lost the completion. */
export type UploadFailure = { readonly kind: 'parts' } | { readonly kind: 'api'; readonly error: RecordsError };

interface PartState {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  url: string;
  status: 'pending' | 'uploading' | 'done';
  etag: string;
  tries: number;
  reissues: number;
  /** Bytes the open request has sent so far, for the bar. */
  sent: number;
}

type PartError = 'expired' | 'transient' | 'aborted';

export function retryDelayMs(tries: number): number {
  return Math.min(8_000, 500 * 2 ** Math.max(0, tries - 1));
}

export class ImportUploader {
  private readonly parts: PartState[];
  private readonly total: number;
  private readonly open = new Set<XMLHttpRequest>();
  private paused = false;
  private stopped = false;
  private failed = false;
  private completing = false;
  private finished = false;
  private active = 0;
  private refreshing: Promise<boolean> | null = null;
  /**
   * When the URLs in hand were issued, by THIS clock (N1): they live five
   * minutes, and `expiresAt` is the server's clock, which a phone's can be
   * minutes away from. A part is sent on a fresh URL once they are that old.
   */
  private issuedAt = Date.now();

  constructor(
    private readonly file: File,
    private readonly plan: ImportUpload,
    private readonly onView: (view: UploadView) => void,
    private readonly onDone: (job: ImportJob) => void,
    private readonly onFail: (failure: UploadFailure) => void,
  ) {
    let offset = 0;
    this.parts = [...plan.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => {
        const state: PartState = { number: part.partNumber, start: offset, end: offset + part.sizeBytes, url: part.url, status: 'pending', etag: '', tries: 0, reissues: 0, sent: 0 };
        offset += part.sizeBytes;
        return state;
      });
    this.total = offset;
  }

  get importId(): string {
    return this.plan.importId;
  }

  start(): void {
    this.emit();
    this.pump();
  }

  pause(): void {
    if (this.finished || this.stopped) return;
    this.paused = true;
    this.emit();
  }

  resume(): void {
    if (this.finished || this.stopped) return;
    this.paused = false;
    if (this.failed) {
      this.failed = false;
      for (const part of this.parts) {
        part.tries = 0;
        part.reissues = 0;
      }
    }
    this.emit();
    this.pump();
  }

  /** Stops every part and abandons the upload at the API (no body). */
  async cancel(): Promise<void> {
    // Nothing to stop once the completion is in flight or done: the API owns the job from there (N3, B1).
    if (this.completing || this.finished || this.stopped) return;
    this.stopped = true;
    for (const request of this.open) request.abort();
    this.open.clear();
    await abortImportUpload(this.plan.importId);
  }

  private view(): UploadView {
    const sent = this.parts.reduce((sum, part) => sum + (part.status === 'done' ? part.end - part.start : part.sent), 0);
    const percent = this.finished ? 100 : Math.min(99, Math.floor((sent / Math.max(1, this.total)) * 100));
    const state: UploadState = this.finished ? 'done' : this.failed ? 'failed' : this.paused ? 'paused' : 'uploading';
    return { state, percent, completing: this.completing };
  }

  private emit(): void {
    if (!this.stopped) this.onView(this.view());
  }

  private pump(): void {
    if (this.stopped || this.paused || this.failed || this.completing || this.finished) return;
    while (this.active < PARTS_IN_FLIGHT) {
      const next = this.parts.find((part) => part.status === 'pending');
      if (next === undefined) break;
      void this.send(next);
    }
    if (this.active === 0 && this.parts.every((part) => part.status === 'done')) void this.complete();
  }

  private async send(part: PartState): Promise<void> {
    part.status = 'uploading';
    part.sent = 0;
    this.active += 1;
    let used = part.url;
    try {
      // A URL lives five minutes: after a pause or a long retry it may be dead already (N1).
      if (Date.now() - this.issuedAt >= URL_LIFETIME_MS - EXPIRY_MARGIN_MS && !(await this.refresh(part, part.url))) {
        part.status = 'pending';
        this.active -= 1;
        this.giveUp();
        return;
      }
      used = part.url;
      part.etag = await this.put(part);
      part.status = 'done';
    } catch (error) {
      part.status = 'pending';
      part.sent = 0;
      if (error !== 'aborted') await this.recover(part, used, error === 'expired');
    }
    this.active -= 1;
    this.emit();
    this.pump();
  }

  /** Decides what a failed try leads to: another try after a pause, a fresh URL, or the end. */
  private async recover(part: PartState, usedUrl: string, expired: boolean): Promise<void> {
    part.tries += 1;
    if (expired) part.reissues += 1;
    if (part.tries >= MAX_TRIES || part.reissues > MAX_REISSUES) {
      this.giveUp();
      return;
    }
    if (expired) {
      if (!(await this.refresh(part, usedUrl))) this.giveUp();
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs(part.tries)));
  }

  private giveUp(): void {
    // Two parts can give up together: one failure is reported once (N5).
    if (this.stopped || this.failed) return;
    this.failed = true;
    this.emit();
    this.onFail({ kind: 'parts' });
  }

  /**
   * New URLs for this part and the ones not yet started: never a part that
   * landed, and never one still open. One re-issue at a time, and a part whose
   * URL another re-issue already replaced does not ask again.
   */
  private async refresh(part: PartState, usedUrl: string): Promise<boolean> {
    while (this.refreshing !== null) await this.refreshing;
    if (part.url !== usedUrl) return true;
    const run = (async (): Promise<boolean> => {
      const wanted = this.parts.filter((candidate) => candidate === part || candidate.status === 'pending');
      const answer = await issueImportUploadUrls(
        this.plan.importId,
        wanted.map((candidate) => candidate.number),
      );
      if (!answer.ok) return false;
      this.issuedAt = Date.now();
      for (const fresh of answer.value.parts as readonly UploadPart[]) {
        const target = this.parts.find((candidate) => candidate.number === fresh.partNumber);
        if (target !== undefined && target.status !== 'done') target.url = fresh.url;
      }
      return true;
    })();
    this.refreshing = run;
    try {
      return await run;
    } finally {
      this.refreshing = null;
    }
  }

  private put(part: PartState): Promise<string> {
    return new Promise<string>((resolve, reject: (reason: PartError) => void) => {
      const request = new XMLHttpRequest();
      this.open.add(request);
      const close = () => this.open.delete(request);
      request.open('PUT', part.url);
      request.upload.onprogress = (event) => {
        part.sent = event.loaded;
        this.emit();
      };
      request.onload = () => {
        close();
        if (request.status >= 200 && request.status < 300) {
          const etag = request.getResponseHeader('ETag');
          if (etag === null || etag === '') reject('transient');
          else resolve(etag);
        } else {
          reject(request.status === 403 ? 'expired' : 'transient');
        }
      };
      request.onerror = () => {
        close();
        reject('transient');
      };
      request.onabort = () => {
        close();
        reject('aborted');
      };
      request.send(this.file.slice(part.start, part.end));
    });
  }

  private async complete(): Promise<void> {
    this.completing = true;
    this.emit();
    const answer = await completeImportUpload(
      this.plan.importId,
      this.parts.map((part) => ({ partNumber: part.number, etag: part.etag })),
    );
    if (this.stopped) return;
    if (answer.ok) {
      this.completing = false;
      this.finished = true;
      this.emit();
      this.onDone(answer.value);
      return;
    }
    // The answer may have been lost after the API applied it (N2): read the job, and carry on if it moved past the upload.
    if (answer.error.code === 'network') {
      const read = await getImport(this.plan.importId);
      if (read.ok && read.value.status !== 'awaiting_upload') {
        this.completing = false;
        this.finished = true;
        this.emit();
        this.onDone(read.value);
        return;
      }
    }
    this.completing = false;
    this.failed = true;
    this.emit();
    this.onFail({ kind: 'api', error: answer.error });
  }
}
