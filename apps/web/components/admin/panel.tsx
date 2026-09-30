'use client';

import type { ReactNode } from 'react';
import type { Translator, MessageId } from '@kasuwa/i18n';
import { Icon } from '../icon';
import { useLiteMode } from '../auth/lite-mode';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import type { ScreenError } from '../../lib/admin-api';
import type { Resource } from './use-resource';

/**
 * Renders one resource's four states so that no screen in this console
 * re-invents them — and, more to the point, so that none of them quietly omits
 * the slow one.
 */

/** `admin.error.<code>`. Switching on `code` and never on `message`. */
export function errorMessageId(error: ScreenError): MessageId {
  return `admin.error.${error.code}` as MessageId;
}

export function Skeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <>
      <span className="sr-only" role="status">
        {label}
      </span>
      <div aria-hidden="true" className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="h-10 rounded-md bg-surface-sunken" />
        ))}
      </div>
    </>
  );
}

/**
 * The slow-network state. Skeleton, then a message, then an offer — the same
 * shape as `P01/1d`, because it is the same NFR.
 */
export function StillConnecting({ t }: { t: Translator }) {
  const { lite, setLite } = useLiteMode();

  return (
    <div
      role="status"
      data-testid="still-connecting"
      className="flex flex-col gap-3 rounded-lg bg-info-soft p-4 text-body-sm text-info-text"
    >
      <p className="flex items-center gap-3 font-bold">
        <span
          aria-hidden="true"
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-e-transparent motion-reduce:animate-none"
        />
        {t.t('admin.slow.title')}
      </p>
      <p className="text-text-2">{t.t('admin.slow.body')}</p>
      {lite ? null : (
        <div>
          <button
            type="button"
            data-testid="switch-to-lite"
            onClick={() => setLite(true)}
            className={SECONDARY_BUTTON}
          >
            {t.t('admin.slow.switch')}
          </button>
        </div>
      )}
    </div>
  );
}

export function ErrorPanel({
  t,
  error,
  onRetry,
}: {
  t: Translator;
  error: ScreenError;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="panel-error"
      data-error-code={error.code}
      className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
    >
      <p className="flex items-center gap-2 font-bold">
        <Icon name="error" size="sm" />
        {t.t('admin.error.title')}
      </p>
      <p>{t.t(errorMessageId(error))}</p>
      {onRetry === undefined ? null : (
        <button type="button" onClick={onRetry} className={QUIET_BUTTON}>
          {t.t('admin.retry')}
        </button>
      )}
    </div>
  );
}

/**
 * `children` runs only with data in hand, so no screen writes `data?.foo` and
 * silently renders an empty table when a request failed.
 */
export function Panel<T>({
  t,
  resource,
  skeletonRows,
  children,
}: {
  t: Translator;
  resource: Resource<T>;
  skeletonRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.slow) return <StillConnecting t={t} />;
  if (resource.error !== null) {
    return <ErrorPanel t={t} error={resource.error} onRetry={resource.reload} />;
  }
  if (resource.data === null) {
    return <Skeleton rows={skeletonRows ?? 3} label={t.t('admin.loading')} />;
  }
  return <>{children(resource.data)}</>;
}
