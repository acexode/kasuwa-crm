'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { formatWhen } from '../import/import-text';

/**
 * A person's name as P28 draws it: record data, drawn as text and never
 * parsed, or — when field security withholds it (`null`) — a label of ours,
 * never the word "null" and never marked as record data.
 */
export function PersonName({ t, name }: { t: Translator; name: string | null }) {
  if (name === null) return <span className="text-text-2">{t.t('duplicates.withheld')}</span>;
  return (
    <span data-record-text="" dir="auto" className="min-w-0 break-words font-semibold">
      {name}
    </span>
  );
}

/** An instant in the reader's zone, in a `<time>` so a machine can read it too. */
export function When({ locale, iso }: { locale: string; iso: string }) {
  return <time dateTime={iso}>{formatWhen(locale, iso)}</time>;
}

/** A refusal or a failure, in words. One at a time, announced once when it appears. */
export function Banner({ t, message }: { t: Translator; message: MessageId }) {
  return (
    <p
      role="alert"
      data-testid="duplicates-error"
      className="flex items-start gap-2 rounded-lg border border-danger bg-danger-soft p-3 text-body-sm text-danger-text"
    >
      <Icon name="error" size="sm" />
      {t.t(message)}
    </p>
  );
}

/** A skeleton and an sr-only status; never a bare spinner, never the empty state while a read is in flight. */
export function Skeleton({ t, label, rows = 3 }: { t: Translator; label: MessageId; rows?: number }) {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        {t.t(label)}
      </span>
      <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="h-10 rounded-sm bg-surface-sunken" />
        ))}
      </div>
    </div>
  );
}
