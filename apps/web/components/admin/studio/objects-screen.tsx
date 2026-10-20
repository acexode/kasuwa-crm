'use client';

import Link from 'next/link';
import { useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import type { LanguageOption } from '../../auth/language-menu';
import { Icon } from '../../icon';
import { CUSTOM_FIELD_OBJECTS } from '../../../lib/custom-fields-api';
import { OBJECT_ICON, studioHref } from '../custom-fields/object-header';
import {
  STUDIO_CHIP,
  STUDIO_INPUT,
  STUDIO_PRIMARY,
  STUDIO_SEGMENT,
  STUDIO_SEGMENTED,
  STUDIO_SEGMENT_OFF,
  STUDIO_SEGMENT_ON,
} from '../custom-fields/studio-classes';
import { StudioFrame } from '../custom-fields/studio-frame';
import { OBJECT_LABEL } from '../custom-fields/studio-text';

/**
 * `P18/A` — the object manager (T-0142), a placeholder behind `studio_objects`
 * (D-L194): custom objects are not built, so the screen is the export's own,
 * listing the four standard objects the custom-field contract names, and
 * nothing else. Every count it cannot know is a dash, never a number; "New
 * object" is drawn disabled; the custom-objects meter says none exist yet.
 * Each row opens that object's fields.
 */

const COLUMNS =
  'md:grid-cols-[minmax(200px,2.2fr)_100px_70px_100px_minmax(150px,1.4fr)_110px_120px]';

export function ObjectsScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
  relationships,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  relationships: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const [filter, setFilter] = useState<'all' | 'standard' | 'custom'>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase(locale);
  const rows =
    filter === 'custom'
      ? []
      : CUSTOM_FIELD_OBJECTS.filter(
          (object) => needle === '' || `${t.t(OBJECT_LABEL[object])} ${object}`.toLocaleLowerCase(locale).includes(needle),
        );
  const chips = [
    { id: 'all' as const, label: t.t('admin.studio.objects.all'), count: CUSTOM_FIELD_OBJECTS.length },
    { id: 'standard' as const, label: t.t('admin.studio.object.standard'), count: CUSTOM_FIELD_OBJECTS.length },
    { id: 'custom' as const, label: t.t('admin.studio.object.custom'), count: 0 },
  ];

  return (
    <StudioFrame
      t={t}
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="cu-obj"
      crumbs={[{ label: t.t('admin.studio.objects.title') }]}
    >
      <div data-screen="P18/A" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
            <h1 className="text-title">{t.t('admin.studio.objects.title')}</h1>
            <p className="max-w-3xl text-label font-normal text-text-2">{t.t('admin.studio.objects.intro')}</p>
          </div>
          <div role="group" aria-label={t.t('admin.studio.view')} className={STUDIO_SEGMENTED}>
            <span aria-current="page" className={`${STUDIO_SEGMENT} ${STUDIO_SEGMENT_ON}`}>
              <Icon name="list" size={20} />
              {t.t('admin.studio.view.list')}
            </span>
            {relationships ? (
              <Link href="/admin/studio/relationships" className={`${STUDIO_SEGMENT} ${STUDIO_SEGMENT_OFF}`}>
                <Icon name="schema" size={20} />
                {t.t('admin.studio.relationships')}
              </Link>
            ) : null}
          </div>
          <button type="button" disabled title={t.t('admin.studio.objects.newSoon')} className={STUDIO_PRIMARY}>
            <Icon name="add" size={20} />
            {t.t('admin.studio.objects.new')}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1 basis-48 sm:max-w-72">
            <Icon name="search" size={20} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.t('admin.studio.objects.search')}
              aria-label={t.t('admin.studio.objects.search')}
              className={`${STUDIO_INPUT} ps-9`}
            />
          </div>
          <div role="group" aria-label={t.t('admin.studio.objects.filter')} className="flex flex-wrap gap-1.5">
            {chips.map((chip) => {
              const on = chip.id === filter;
              return (
                <button
                  key={chip.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(chip.id)}
                  className={`${STUDIO_CHIP} ${on ? 'border-primary bg-primary-soft text-primary-text' : 'border-border bg-surface text-text is-hover:bg-surface-sunken'}`}
                >
                  {chip.label}
                  <span className="font-medium">{chip.count}</span>
                </button>
              );
            })}
          </div>
          <span className="hidden flex-1 md:block" />
          <div className="flex min-w-44 flex-col gap-1">
            <span className="flex justify-between gap-2 text-caption font-normal text-text-2">
              <span>{t.t('admin.studio.objects.meter')}</span>
              <b className="text-text">{t.t('admin.studio.objects.meterNone')}</b>
            </span>
            <span aria-hidden="true" className="block h-1.5 rounded-full bg-surface-sunken" />
          </div>
        </div>

        <div role="table" aria-label={t.t('admin.studio.objects.title')} className="overflow-hidden rounded-lg border border-border bg-surface">
          <div
            role="row"
            className={`hidden min-h-control-md items-center gap-3 border-b border-border bg-surface-sunken px-4 text-caption font-bold text-text-2 md:grid ${COLUMNS}`}
          >
            <span role="columnheader">{t.t('admin.studio.objects.col.object')}</span>
            <span role="columnheader">{t.t('admin.studio.col.type')}</span>
            <span role="columnheader">{t.t('admin.studio.objects.col.fields')}</span>
            <span role="columnheader">{t.t('admin.studio.objects.col.records')}</span>
            <span role="columnheader">{t.t('admin.studio.objects.col.scope')}</span>
            <span role="columnheader">{t.t('admin.studio.objects.col.features')}</span>
            <span role="columnheader">{t.t('admin.studio.col.modified')}</span>
          </div>
          {rows.map((object) => (
            <Link
              key={object}
              role="row"
              href={studioHref('fields', object)}
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-body-sm text-text outline-none last:border-b-0 is-hover:bg-surface-sunken focus-visible:ring-focus md:py-3 ${COLUMNS}`}
            >
              <span role="cell" className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
                  <Icon name={OBJECT_ICON[object]} size={20} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <b className="truncate">{t.t(OBJECT_LABEL[object])}</b>
                  <span dir="ltr" className="truncate text-start font-mono text-caption font-normal text-text-2">
                    {object}
                  </span>
                </span>
              </span>
              <span role="cell">
                <span className="inline-flex h-5.5 items-center rounded-full bg-surface-sunken px-2 text-caption font-bold text-text-2">
                  {t.t('admin.studio.object.standard')}
                </span>
              </span>
              <span role="cell" className="hidden text-text-muted md:block">
                {t.t('admin.studio.meter.unknown')}
              </span>
              <span role="cell" className="hidden text-text-muted md:block">
                {t.t('admin.studio.meter.unknown')}
              </span>
              <span role="cell" className="col-start-1 flex min-w-0 items-center gap-1.5 text-text-2 md:col-start-auto">
                <Icon name="public" size={18} />
                <span className="truncate">{t.t('admin.studio.object.allProgrammes')}</span>
              </span>
              <span role="cell" className="hidden md:block" />
              <span role="cell" className="hidden text-meta text-text-muted md:block">
                {t.t('admin.studio.meter.unknown')}
              </span>
            </Link>
          ))}
          {rows.length === 0 ? (
            <div className="px-6 py-10 text-center text-body-sm text-text-2">
              {t.t(filter === 'custom' ? 'admin.studio.objects.noCustom' : 'admin.studio.objects.noMatch')}
            </div>
          ) : null}
        </div>
      </div>
    </StudioFrame>
  );
}
