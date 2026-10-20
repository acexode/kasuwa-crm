'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Spinner } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import type { RecordsError } from '../../lib/records-api';
import type { SearchType } from '../../lib/search-api';
import { LEAD_STATUS_LABEL, LEAD_STATUS_TONE, TYPE_ICON, TYPE_TINT, highlight, type SearchRow } from './search-model';

/**
 * The P27 parts every search surface draws (T-0138): the top-bar dropdown
 * (A–A5), the results page (C) and the record rows of the command palette
 * (D1). One set, so the three cannot drift from each other or the export.
 *
 * Record text is text: React escapes it, and nothing here sets inner HTML.
 * Every state keeps its test id from T-0087: `search-loading`, `search-empty`,
 * `search-error`, `search-hint` and `search-invalid`.
 */

/** The section labels: 12/700, 0.04em, upper case, text-2. */
export const SECTION_LABEL = 'text-caption font-bold uppercase leading-4 tracking-[0.04em] text-text-2';
/** The shell's focus ring, for every control drawn here. */
export const FOCUS = 'outline-none focus-visible:ring-focus';

/** The typed words marked in a name: 800 on accent-soft, radius 3 (P27 `segs`). */
export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-[3px] bg-accent-soft font-extrabold text-inherit">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** The name, highlighted; with no readable name, a lock and a neutral label, never the id (D-L68). */
export function RowName({ row, query, t }: { row: SearchRow; query: string; t: Translator }) {
  if (row.name === null) {
    return (
      <span data-field="name" data-locked="true" className="flex min-w-0 items-center gap-1 font-normal text-text-2">
        <Icon name="lock" size={16} />
        <span className="truncate">{t.t('search.hit.nameWithheld')}</span>
      </span>
    );
  }
  return (
    <span data-field="name" data-record-text="" className="min-w-0 truncate">
      <Highlighted text={row.name} query={query} />
    </span>
  );
}

/** The 32px (radius 8, 18px glyph) or 40px (radius 10, 20px glyph) type tile. */
export function TypeTile({ type, large = false }: { type: SearchType; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center ${large ? 'size-10 rounded-10' : 'size-8 rounded-md'} ${TYPE_TINT[type]}`}
    >
      <Icon name={TYPE_ICON[type]} size={large ? 20 : 18} />
    </span>
  );
}

/** A lead's status: 11/700 on its soft fill, radius 999; 22px in the dropdown, 20px on the results page. */
export function StatusPill({ status, t, small = false }: { status: string; t: Translator; small?: boolean }) {
  const label = LEAD_STATUS_LABEL[status];
  if (label === undefined) return null;
  return (
    <span
      data-field="status"
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full text-micro ${small ? 'h-5 px-[7px]' : 'h-5.5 px-2'} ${
        LEAD_STATUS_TONE[status] ?? 'bg-surface-sunken text-text-2'
      }`}
    >
      {t.t(label)}
    </span>
  );
}

/** A key in a footer or a command row: 20px, mono 11/600, border on sunken (on surface in the palette's sunken footer). */
export function KeyCap({ children, onSunken = false }: { children: ReactNode; onSunken?: boolean }) {
  return (
    <kbd
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border px-1 font-mono text-micro font-semibold text-text-2 ${
        onSunken ? 'bg-surface' : 'bg-surface-sunken'
      }`}
    >
      {children}
    </kbd>
  );
}

/** One footer hint: a key and its word ("↑↓ Move"). */
export function KeyHint({ keyLabel, label, onSunken = false }: { keyLabel: ReactNode; label: string; onSunken?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <KeyCap onSunken={onSunken}>{keyLabel}</KeyCap>
      {label}
    </span>
  );
}

/** The arrow, return and shift glyphs: keys, not words, so they are not translated. */
export const KEYS = { move: '↑↓', enter: '↵', question: '?', shift: '⇧' } as const;

/**
 * The info-soft phone strip (P27 A2, C1). For a whole number it says how the
 * number is matched; for a number still being typed it carries the existing
 * "type the whole number" guidance (D-L195), never the design's partial match.
 */
export function PhoneStrip({ t, typing, page = false }: { t: Translator; typing: boolean; page?: boolean }) {
  return (
    <p
      data-testid={typing ? 'search-hint' : 'search-phone'}
      className={
        page
          ? 'm-0 flex items-start gap-2.5 rounded-10 bg-info-soft px-3.5 py-2.5 text-meta text-text'
          : 'm-0 flex items-start gap-2 bg-info-soft px-4 py-2 text-caption font-normal leading-[17px] text-text'
      }
    >
      <Icon name="dialpad" size={page ? 20 : 18} className="shrink-0 text-info-text" />
      <span>
        <b>{t.t('search.phone.title')}</b> {t.t(typing ? 'search.keepTyping' : 'search.phone.body')}
      </span>
    </p>
  );
}

/**
 * A number or address the lookup refused as not whole. A phone number is
 * drawn as the design's partial-number strip (P27 A2), carrying the existing
 * "type the whole number" guidance and never a partial match (D-L195); an
 * address keeps the warning style.
 */
export function InvalidStrip({ t, field, page = false }: { t: Translator; field: 'phone' | 'email'; page?: boolean }) {
  const phone = field === 'phone';
  return (
    <p
      data-testid="search-invalid"
      data-field={field}
      className={`m-0 flex items-start ${phone ? 'bg-info-soft text-text' : 'bg-warning-soft text-warning-text'} ${
        page ? 'gap-2.5 rounded-10 px-3.5 py-2.5 text-meta' : 'gap-2 px-4 py-2 text-caption font-normal leading-[17px]'
      }`}
    >
      <Icon name={phone ? 'dialpad' : 'warning'} size={page ? 20 : 18} className={`shrink-0 ${phone ? 'text-info-text' : ''}`} />
      {phone ? (
        <span>
          <b>{t.t('search.phone.title')}</b> {t.t('search.invalidPhone')}
        </span>
      ) : (
        t.t('search.invalidEmail')
      )}
    </p>
  );
}

/** Skeleton bars: sunken, radius 4. */
function Bar({ className }: { className: string }) {
  return <span className={`block rounded-sm bg-surface-sunken ${className}`} />;
}

const SKELETON_ROWS: readonly (readonly (readonly [string, string])[])[] = [
  [
    ['w-[42%]', 'w-[64%]'],
    ['w-[34%]', 'w-[52%]'],
  ],
  [
    ['w-[56%]', 'w-[38%]'],
    ['w-[48%]', 'w-[60%]'],
  ],
];

/**
 * P27 A4: a spinner line, then two skeleton groups of two rows, each group
 * with its label stub and each row with a right-hand stub. Never "no matches".
 */
export function LoadingRows({ t, page = false }: { t: Translator; page?: boolean }) {
  return (
    <div data-testid="search-loading" aria-busy="true" className="flex flex-col gap-0.5 py-1.5">
      <span className="flex items-center gap-2 px-4 pb-2 pt-1.5 text-caption font-normal text-text-muted">
        <Spinner className="size-3 text-primary" />
        {t.t('search.loading.line')}
      </span>
      {SKELETON_ROWS.map((group, groupIndex) => (
        <span key={groupIndex} aria-hidden="true" className="flex flex-col gap-0.5">
          <Bar className={`mx-4 h-2.5 ${groupIndex === 0 ? 'my-1.5 w-[90px]' : 'mb-1.5 mt-3.5 w-[70px]'}`} />
          {group.map(([title, sub], index) => (
            <span key={index} className={`flex items-center gap-3 px-4 ${page ? 'h-[68px]' : 'h-[52px]'}`}>
              <span className={`shrink-0 bg-surface-sunken ${page ? 'size-10 rounded-10' : 'size-8 rounded-md'}`} />
              <span className="flex flex-1 flex-col gap-1.5">
                <Bar className={`h-3 ${title}`} />
                <Bar className={`h-2.5 ${sub}`} />
              </span>
              <Bar className="h-2.5 w-[52px]" />
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/**
 * P27 A5: the centred no-matches state. A 48px sunken disc with search_off,
 * `No matches for "…"`, one hint, then Create contact (primary) and Create
 * lead. Neither create flow exists in the app yet, so both are drawn in the
 * list screens' "Not available yet" state, never as a link to nothing. A
 * lookup never repeats the number or address it was given.
 */
export function NoMatches({
  t,
  query,
  lookup,
  filtered = false,
  onClearFilters,
  page = false,
}: {
  t: Translator;
  query: string;
  lookup: boolean;
  filtered?: boolean;
  onClearFilters?: () => void;
  page?: boolean;
}) {
  const shown = [...query].length > 22 ? `${[...query].slice(0, 22).join('')}…` : query;
  const title: string = filtered
    ? t.t('search.filtered.title')
    : lookup
      ? t.t('search.empty.title')
      : t.t('search.noMatch.title', { q: shown });
  const body: MessageId = filtered ? 'search.filtered.body' : lookup ? 'search.noMatch.lookupBody' : 'search.empty.body';
  return (
    <div data-testid="search-empty" className={`flex flex-col items-center gap-2 text-center ${page ? 'px-6 py-10' : 'px-6 pb-5 pt-7'}`}>
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-text-2">
        <Icon name="search_off" size={26} />
      </span>
      <b className="text-card-title">{title}</b>
      <span className="max-w-[420px] text-meta text-text-2">{t.t(body)}</span>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <CreateButton
          t={t}
          primary
          label={lookup || query === '' ? t.t('search.create.contact') : t.t('search.create.contactNamed', { q: shown })}
        />
        {filtered && onClearFilters !== undefined ? (
          <button
            type="button"
            onClick={onClearFilters}
            className={`inline-flex h-control-md items-center rounded-md border border-border bg-surface px-3.5 text-body-sm font-semibold text-text is-hover:bg-surface-sunken ${FOCUS}`}
          >
            {t.t('search.filtered.clear')}
          </button>
        ) : (
          <CreateButton t={t} label={t.t('search.create.lead')} />
        )}
      </div>
    </div>
  );
}

function CreateButton({ t, label, primary = false }: { t: Translator; label: string; primary?: boolean }) {
  return (
    <button
      type="button"
      aria-disabled="true"
      title={t.t('records.action.unavailable')}
      className={`inline-flex h-control-md cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 text-body-sm font-semibold ${FOCUS} ${
        primary ? 'bg-primary text-on-primary' : 'border border-border bg-surface text-text'
      }`}
    >
      {primary ? <Icon name="person_add" size={20} /> : null}
      {label}
      <span className="sr-only">{t.t('records.action.unavailable')}</span>
    </button>
  );
}

/**
 * A failed read: never "no matches", and said for what it is (D-L137 M5). A
 * throttled search says to wait, and its Retry stays off until the
 * contract's `retryAt` has passed; a refusal the screen did not expect says
 * the request was not accepted; a lost session says to sign in; anything
 * else is the connection.
 */
function errorCopy(error: RecordsError): MessageId {
  switch (error.code) {
    case 'too_many_requests':
      return 'records.error.too_many_requests';
    case 'validation_failed':
      return 'records.error.validation_failed';
    case 'not_authenticated':
      return 'records.error.not_authenticated';
    default:
      return 'search.error.body';
  }
}

export function SearchError({
  error,
  t,
  onRetry,
  page = false,
}: {
  error: RecordsError;
  t: Translator;
  onRetry: () => void;
  page?: boolean;
}) {
  const waitUntil = error.code === 'too_many_requests' && error.retryAt !== undefined ? Date.parse(error.retryAt) : Number.NaN;
  const [waiting, setWaiting] = useState(() => Number.isFinite(waitUntil) && waitUntil > Date.now());
  useEffect(() => {
    if (!Number.isFinite(waitUntil)) return undefined;
    const left = waitUntil - Date.now();
    if (left <= 0) {
      setWaiting(false);
      return undefined;
    }
    setWaiting(true);
    const timer = window.setTimeout(() => setWaiting(false), left);
    return () => window.clearTimeout(timer);
  }, [waitUntil]);
  return (
    <div
      role="alert"
      data-testid="search-error"
      data-error-code={error.code}
      className={`flex flex-col items-center gap-2 text-center ${page ? 'px-6 py-10' : 'px-6 pb-5 pt-7'}`}
    >
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger-text">
        <Icon name="error" size={26} />
      </span>
      <b className="text-card-title">{t.t('search.error.title')}</b>
      <span className="max-w-[420px] text-meta text-text-2">{t.t(errorCopy(error))}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={waiting}
        className={`mt-2 inline-flex h-control-md items-center rounded-md border border-border bg-surface px-3.5 text-body-sm font-semibold text-text is-hover:bg-surface-sunken disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-text ${FOCUS}`}
      >
        {t.t('records.retry')}
      </button>
    </div>
  );
}
