'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Avatar, EmptyState, IconButton, Pill, Radio, Switch, TextField } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { ToggleChip } from './activity-chips';

/**
 * P07/22–25 — Booking pages (T-0136), behind `booking_pages` (D-L194, D-P22).
 *
 * The module that publishes a booking page does not exist, so this is the
 * design's editor in its empty, disabled state: the same card, fields and
 * live-preview frame, every control disabled and blank, and the preview
 * showing that there is no page yet. Nothing here is saved, published or
 * sent, and no name, slot or total is invented.
 */

const LENGTHS = [15, 30, 45, 60] as const;
const PLACES = [
  { key: 'video', icon: 'videocam' },
  { key: 'phone', icon: 'call' },
  { key: 'person', icon: 'location_on' },
] as const;
const CHANNELS = [
  { key: 'whatsapp', icon: 'chat' },
  { key: 'sms', icon: 'sms' },
  { key: 'email', icon: 'mail' },
] as const;
const QUESTIONS = ['name', 'phone'] as const;

export function BookingPages({ t, owner }: { t: Translator; owner: string | null }) {
  return (
    <div data-placeholder="booking-pages" className="grid items-start gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <section
        aria-label={t.t('activities.booking.settings')}
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-[18px]"
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-h5 font-bold">{t.t('activities.booking.title')}</h2>
          <Pill tone="neutral">{t.t('activities.booking.notSetUp')}</Pill>
        </div>
        <TextField label={t.t('activities.booking.pageTitle')} disabled placeholder={t.t('activities.booking.pageTitle.placeholder')} />
        <TextField
          label={t.t('activities.booking.link')}
          disabled
          mono
          placeholder={t.t('activities.booking.link.placeholder')}
          trailing={<IconButton variant="ghost" icon="content_copy" label={t.t('activities.booking.copy')} disabled className="!size-9" />}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body-sm font-semibold">{t.t('activities.booking.length')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {LENGTHS.map((length) => (
              <ToggleChip key={length} size="choice" pressed={false} disabled>
                {t.t('activities.compose.minutes', { count: length })}
              </ToggleChip>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-body-sm font-semibold">{t.t('activities.booking.where')}</legend>
          {PLACES.map((place) => (
            <Radio
              key={place.key}
              name="booking-where"
              disabled
              label={
                <span className="inline-flex items-center gap-2.5">
                  <Icon name={place.icon} size={18} className="text-text-2" />
                  {t.t(`activities.booking.where.${place.key}` as MessageId)}
                </span>
              }
            />
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5 rounded-10 bg-surface-sunken p-3 text-meta">
          <b className="text-body-sm font-bold">{t.t('activities.booking.availability')}</b>
          <span className="text-text-2">{t.t('activities.booking.availability.none')}</span>
          <Switch label={t.t('activities.booking.holidays')} checked={false} disabled />
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-body-sm font-semibold">{t.t('activities.booking.questions')}</legend>
          {QUESTIONS.map((question) => (
            <span key={question} className="flex min-h-10 items-center gap-2 rounded-md border border-border px-2.5 text-meta text-text-2">
              <Icon name="drag_indicator" size={18} className="text-text-muted" />
              <span className="flex-1">{t.t(`activities.booking.question.${question}` as MessageId)}</span>
              <span className="text-micro text-text-muted">{t.t('activities.booking.required')}</span>
            </span>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-body-sm font-semibold">{t.t('activities.booking.confirm')}</legend>
          {CHANNELS.map((channel) => (
            <span key={channel.key} className="flex min-h-12 items-center gap-2.5">
              <Icon name={channel.icon} size={20} className="text-text-2" />
              <span className="flex flex-1 flex-col">
                <b className="text-body-sm font-bold text-text-2">{t.t(`activities.compose.remind.${channel.key}` as MessageId)}</b>
              </span>
              <Switch aria-label={t.t(`activities.compose.remind.${channel.key}` as MessageId)} checked={false} disabled />
            </span>
          ))}
        </fieldset>
      </section>

      <section aria-label={t.t('activities.booking.preview')} className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <b className="flex-1 text-body-sm font-bold">{t.t('activities.booking.preview')}</b>
          <span className="text-caption text-text-muted">{t.t('activities.booking.preview.hint')}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-surface-sunken">
          <div className="flex h-9 items-center gap-2 border-b border-border bg-surface px-3">
            <span aria-hidden="true" className="flex gap-[5px]">
              <span className="size-2.5 rounded-full bg-border-strong" />
              <span className="size-2.5 rounded-full bg-border-strong" />
              <span className="size-2.5 rounded-full bg-border-strong" />
            </span>
            <span className="flex h-6 max-w-[340px] flex-1 items-center gap-1.5 rounded-6 bg-surface-sunken px-2.5 font-mono text-[11px] text-text-2">
              <Icon name="lock" size={14} />
            </span>
          </div>
          <div className="flex justify-center p-6">
            <div className="flex w-full max-w-[640px] flex-col items-center gap-4 rounded-14 border border-border bg-surface px-6 py-10 shadow-2">
              {owner === null ? null : <Avatar name={owner} size={44} className="!bg-accent-soft !text-accent-text" />}
              <EmptyState
                align="center"
                icon="event_available"
                title={t.t('activities.booking.empty.title')}
                body={t.t('activities.booking.empty.body')}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
