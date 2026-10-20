'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { useLiteMode } from '../auth/lite-mode';
import { SECONDARY_BUTTON } from '../auth/button-classes';

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
