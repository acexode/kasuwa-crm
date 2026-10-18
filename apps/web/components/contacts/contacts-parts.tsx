'use client';

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
