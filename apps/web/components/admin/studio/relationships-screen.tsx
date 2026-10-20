'use client';

import Link from 'next/link';
import { useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import type { LanguageOption } from '../../auth/language-menu';
import { Icon } from '../../icon';
import { CUSTOM_FIELD_OBJECTS, type CustomFieldObject } from '../../../lib/custom-fields-api';
import { OBJECT_ICON, studioHref } from '../custom-fields/object-header';
import {
  STUDIO_PRIMARY,
  STUDIO_SEGMENT,
  STUDIO_SEGMENTED,
  STUDIO_SEGMENT_OFF,
  STUDIO_SEGMENT_ON,
} from '../custom-fields/studio-classes';
import { StudioFrame } from '../custom-fields/studio-frame';
import { OBJECT_LABEL } from '../custom-fields/studio-text';

/**
 * `P18/A2` — the relationships view (T-0142), a placeholder behind
 * `studio_relationships` (D-L194). No lookup or master-detail field exists
 * yet, so the canvas holds the four standard objects with no line between
 * them, and the selected object's panel says it has no relationships: the
 * export's own empty wording. The zoom and the standard-objects switch are
 * drawn disabled; there is nothing to zoom or hide.
 */

export function RelationshipsScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
  objects,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  /** The object manager is on, so the List segment and the crumb link to it. */
  objects: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const [selected, setSelected] = useState<CustomFieldObject>('contact');

  return (
    <StudioFrame
      t={t}
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="cu-obj"
      crumbs={[
        ...(objects ? [{ label: t.t('admin.studio.objects.title'), href: '/admin/studio' }] : []),
        { label: t.t('admin.studio.relationships') },
      ]}
    >
      <div data-screen="P18/A2" className="-mx-4 -mb-4 flex flex-col md:-mx-6 md:-mb-6 xl:-mx-8 xl:-mb-10">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-4 pb-4 md:px-6 xl:px-8">
          <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
            <h1 className="text-title">{t.t('admin.studio.relationships')}</h1>
            <p className="max-w-3xl text-label font-normal text-text-2">{t.t('admin.studio.relationships.intro')}</p>
          </div>
          <div role="group" aria-label={t.t('admin.studio.view')} className={STUDIO_SEGMENTED}>
            {objects ? (
              <Link href="/admin/studio" className={`${STUDIO_SEGMENT} ${STUDIO_SEGMENT_OFF}`}>
                <Icon name="list" size={20} />
                {t.t('admin.studio.view.list')}
              </Link>
            ) : null}
            <span aria-current="page" className={`${STUDIO_SEGMENT} ${STUDIO_SEGMENT_ON}`}>
              <Icon name="schema" size={20} />
              {t.t('admin.studio.relationships')}
            </span>
          </div>
        </div>

        <div className="flex min-h-96 flex-col border-t border-border lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col bg-surface-sunken">
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
              <div className="flex items-center overflow-hidden rounded-md border border-border">
                <button type="button" disabled aria-label={t.t('admin.studio.relationships.zoomOut')} className="flex h-control-base w-9 items-center justify-center text-disabled-text md:h-8">
                  <Icon name="remove" size={20} />
                </button>
                <span className="px-2 text-meta font-semibold text-text-2">{t.t('admin.studio.relationships.zoom', { percent: 100 })}</span>
                <button type="button" disabled aria-label={t.t('admin.studio.relationships.zoomIn')} className="flex h-control-base w-9 items-center justify-center text-disabled-text md:h-8">
                  <Icon name="add" size={20} />
                </button>
              </div>
              <span className="flex items-center gap-2 text-meta font-semibold text-text-2">
                <span aria-hidden="true" className="flex h-6.5 w-11 items-center justify-end rounded-full bg-disabled-bg p-0.75 shadow-switch-disabled">
                  <span className="size-5 rounded-full bg-surface shadow-knob" />
                </span>
                {t.t('admin.studio.relationships.showStandard')}
              </span>
              <span className="flex-1" />
              <span className="flex flex-wrap items-center gap-3.5 text-caption font-normal text-text-2">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="w-5.5 border-t-2 border-text-2" />
                  {t.t('admin.studio.relationships.masterDetail')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="w-5.5 border-t-2 border-dashed border-text-2" />
                  {t.t('admin.studio.relationships.lookup')}
                </span>
              </span>
            </div>
            <div className="flex-1 overflow-auto [background-image:radial-gradient(var(--k-border)_1px,transparent_1px)] [background-size:20px_20px] p-6">
              <div className="grid max-w-3xl grid-cols-1 gap-x-16 gap-y-10 sm:grid-cols-2">
                {CUSTOM_FIELD_OBJECTS.map((object) => {
                  const on = object === selected;
                  return (
                    <button
                      key={object}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSelected(object)}
                      className={`flex h-16 items-center gap-2.5 rounded-10 bg-surface px-3 text-start outline-none focus-visible:ring-focus ${
                        on ? 'border-2 border-primary shadow-2' : 'border border-border shadow-1'
                      }`}
                    >
                      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
                        <Icon name={OBJECT_ICON[object]} size={20} />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <b className="truncate text-body-sm">{t.t(OBJECT_LABEL[object])}</b>
                        <span dir="ltr" className="truncate text-start font-mono text-caption font-normal text-text-2">
                          {object}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <aside
            aria-label={t.t('admin.studio.relationships.selected')}
            className="flex w-full shrink-0 flex-col gap-4 border-t border-border bg-surface p-5 lg:w-layout-studio-aside lg:border-s lg:border-t-0"
          >
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-10 bg-primary-soft text-primary-text">
                <Icon name={OBJECT_ICON[selected]} size={24} />
              </span>
              <div className="flex min-w-0 flex-col">
                <b className="truncate text-label font-bold">{t.t(OBJECT_LABEL[selected])}</b>
                <span dir="ltr" className="truncate text-start font-mono text-caption font-normal text-text-2">
                  {selected}
                </span>
              </div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-meta">
              <dt className="text-text-muted">{t.t('admin.studio.col.type')}</dt>
              <dd>
                <span className="inline-flex h-5.5 items-center rounded-full bg-surface-sunken px-2 text-caption font-bold text-text-2">
                  {t.t('admin.studio.object.standard')}
                </span>
              </dd>
              <dt className="text-text-muted">{t.t('admin.studio.objects.col.scope')}</dt>
              <dd>{t.t('admin.studio.object.allProgrammes')}</dd>
            </dl>
            <div className="flex flex-col gap-2">
              <b className="text-body-sm">{t.t('admin.studio.relationships')}</b>
              <span className="text-meta text-text-2">{t.t('admin.studio.relationships.none')}</span>
            </div>
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href={studioHref('fields', selected)} className={`${STUDIO_PRIMARY} flex-1`}>
                {t.t('admin.studio.relationships.open')}
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </StudioFrame>
  );
}
