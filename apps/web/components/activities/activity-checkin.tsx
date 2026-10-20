'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { ToggleChip } from './activity-chips';

/**
 * P07/26–29 — Field check-in (T-0136), behind `field_checkin` (D-L194).
 *
 * There is no field-visit module, so this is the design's check-in form in
 * its disabled, empty state: no visit, no location read, no photo taken, and
 * every control off. Nothing is queued or stored (D-P21).
 */

const OUTCOMES = [
  { key: 'met', icon: 'handshake' },
  { key: 'order', icon: 'shopping_cart' },
  { key: 'samples', icon: 'inventory_2' },
  { key: 'away', icon: 'person_off' },
  { key: 'closed', icon: 'block' },
] as const;

export function FieldCheckin({ t }: { t: Translator }) {
  return (
    <div data-placeholder="field-checkin" className="mx-auto flex w-full max-w-[440px] flex-col gap-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-overline text-text-muted">{t.t('activities.checkin.eyebrow')}</span>
        <b className="text-[19px] font-bold leading-[26px]">{t.t('activities.checkin.none')}</b>
        <span className="text-meta text-text-2">{t.t('activities.checkin.none.body')}</span>
      </div>
      <div
        role="img"
        aria-label={t.t('activities.checkin.map')}
        className="relative h-[200px] overflow-hidden rounded-lg border border-border bg-surface-sunken bg-[linear-gradient(var(--k-border)_1px,transparent_1px),linear-gradient(90deg,var(--k-border)_1px,transparent_1px)] bg-[size:28px_28px]"
      >
        <span className="absolute inset-x-2 bottom-2 flex flex-col gap-0.5 rounded-md bg-surface px-2.5 py-2 text-caption shadow-1">
          <b className="text-meta font-bold">{t.t('activities.checkin.location')}</b>
          <span className="text-text-2">{t.t('activities.checkin.location.body')}</span>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-sm font-semibold">{t.t('activities.checkin.photo')}</span>
        <button
          type="button"
          disabled
          className="flex min-h-16 items-center gap-3 rounded-10 border-2 border-dashed border-border-strong bg-surface px-3.5 py-2.5 text-start text-disabled-text"
        >
          <Icon name="photo_camera" size={28} />
          <span className="flex flex-col gap-px">
            <b className="text-body-sm font-bold">{t.t('activities.checkin.photo.take')}</b>
            <span className="text-caption">{t.t('activities.checkin.photo.hint')}</span>
          </span>
        </button>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body-sm font-semibold">{t.t('activities.checkin.outcome')}</legend>
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map((outcome) => (
            <ToggleChip key={outcome.key} size="choice" pressed={false} disabled icon={outcome.icon} className="!font-semibold">
              {t.t(`activities.checkin.outcome.${outcome.key}` as MessageId)}
            </ToggleChip>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1.5">
        <span className="text-body-sm font-semibold">{t.t('activities.compose.notes')}</span>
        <textarea
          rows={3}
          disabled
          placeholder={t.t('activities.checkin.notes.placeholder')}
          className="min-h-[84px] resize-y rounded-md border border-border bg-surface px-3 py-2.5 text-label font-normal text-disabled-text placeholder:text-disabled-text"
        />
      </label>
      <Button variant="primary" icon="where_to_vote" disabled className="!h-control-xl !rounded-10 !text-body-md !font-bold">
        {t.t('activities.checkin.submit')}
      </Button>
    </div>
  );
}
