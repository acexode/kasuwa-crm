'use client';

import Link from 'next/link';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';

/** A control for something that is not built yet: drawn, named, and disabled with its reason. */
export function UnavailableAction({
  t,
  action,
  icon,
  label,
  primary,
}: {
  t: Translator;
  action: string;
  icon: 'upload_file' | 'add' | 'chat';
  label: MessageId;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-action={action}
      data-requires-connection=""
      aria-disabled="true"
      title={t.t('records.action.unavailable')}
      className={`${primary === true ? PRIMARY_BUTTON : SECONDARY_BUTTON} cursor-not-allowed opacity-60`}
    >
      <Icon name={icon} size="sm" />
      {t.t(label)}
      <span className="sr-only">{t.t('records.action.unavailable')}</span>
    </button>
  );
}

/**
 * The import action where the import screen is live (T-0096, I1): the same
 * `[data-action^="import"]` hook P04 holds, now a link. Offline it is
 * `aria-disabled` and does not navigate, like every control that needs a
 * connection (`data-requires-connection`, P04/06).
 */
export function ImportLink({
  t,
  href,
  action,
  label,
  offline,
}: {
  t: Translator;
  href: string;
  action: string;
  label: MessageId;
  offline: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      data-action={action}
      data-requires-connection=""
      aria-disabled={offline ? 'true' : undefined}
      onClick={(event) => {
        if (offline) event.preventDefault();
      }}
      className={`${SECONDARY_BUTTON} ${offline ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <Icon name="upload_file" size="sm" />
      {t.t(label)}
    </Link>
  );
}
