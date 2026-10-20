'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { IconName } from '@kasuwa/ui';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import type { CustomFieldObject } from '../../../lib/custom-fields-api';
import { OBJECT_TILE, STUDIO_SECONDARY } from './studio-classes';
import { OBJECT_LABEL } from './studio-text';

/**
 * P18's object page header (T-0142): the 52px tile, the 26/800 title, the api
 * name in mono, the Standard chip and the scope, then the object's tabs.
 *
 * Only what is true is drawn. The four objects are Kasuwa's standard ones and
 * a custom-field definition is tenant-wide (ADR-0008), so "Standard" and "All
 * programmes" are facts. The feature chips and the Relationships button are
 * the object manager's and the relationships view's (D-L194), drawn only where
 * those flags are on.
 */

export const OBJECT_ICON: Readonly<Record<CustomFieldObject, IconName>> = {
  contact: 'person',
  account: 'domain',
  activity: 'event_note',
  deal: 'handshake',
};

export type StudioTab = 'fields' | 'layouts' | 'validation';

export interface StudioSections {
  readonly objects: boolean;
  readonly layouts: boolean;
  readonly validation: boolean;
  readonly relationships: boolean;
}

export function studioHref(tab: StudioTab, object: CustomFieldObject): string {
  const base = tab === 'fields' ? '/admin/custom-fields' : tab === 'layouts' ? '/admin/studio/layouts' : '/admin/studio/validation-rules';
  return object === 'contact' ? base : `${base}?object=${object}`;
}

export function ObjectHeader({
  t,
  object,
  sections,
  tab,
  fieldCount,
  switcher,
}: {
  t: Translator;
  object: CustomFieldObject;
  sections: StudioSections;
  tab: StudioTab;
  /** The active custom-field count, once read: the Fields tab's badge. */
  fieldCount: number | null;
  /** The object switcher: the four standard objects. */
  switcher: ReactNode;
}) {
  const tabs: readonly { readonly id: StudioTab; readonly label: string; readonly count: number | null }[] = [
    {
      id: 'fields',
      label: t.t(sections.relationships ? 'admin.studio.tab.fieldsRelationships' : 'admin.studio.tab.fields'),
      count: fieldCount,
    },
    ...(sections.layouts ? [{ id: 'layouts' as const, label: t.t('admin.studio.tab.layouts'), count: null }] : []),
    ...(sections.validation ? [{ id: 'validation' as const, label: t.t('admin.studio.tab.validation'), count: null }] : []),
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span aria-hidden="true" className={OBJECT_TILE}>
          <Icon name={OBJECT_ICON[object]} size={28} />
        </span>
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
          <h1 className="text-title-sm">{t.t(OBJECT_LABEL[object])}</h1>
          <div className="flex flex-wrap items-center gap-2 text-meta text-text-2">
            {/* The object's api name is an identifier the contract serves, not copy to translate (T-0149). */}
            <span dir="ltr" data-record-text="" className="font-mono text-caption">
              {object}
            </span>
            <span className="inline-flex h-5.5 items-center rounded-full bg-surface-sunken px-2 text-caption font-bold text-text-2">
              {t.t('admin.studio.object.standard')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="public" size={16} />
              {t.t('admin.studio.object.allProgrammes')}
            </span>
            {sections.objects && object !== 'activity' ? (
              <>
                <span className="inline-flex h-5.5 items-center gap-1 rounded-6 bg-surface-sunken px-2 text-caption font-semibold text-text">
                  <Icon name="event_note" size={14} />
                  {t.t('admin.studio.object.feature.activities')}
                </span>
                <span className="inline-flex h-5.5 items-center gap-1 rounded-6 bg-surface-sunken px-2 text-caption font-semibold text-text">
                  <Icon name="trending_up" size={14} />
                  {t.t('admin.studio.object.feature.timeline')}
                </span>
              </>
            ) : null}
          </div>
        </div>
        {/* min-w-0: the switcher scrolls inside the line on a phone instead of pushing the page sideways (T-0149). */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {switcher}
          {sections.relationships ? (
            <Link href="/admin/studio/relationships" className={STUDIO_SECONDARY}>
              <Icon name="schema" size={20} />
              {t.t('admin.studio.relationships')}
            </Link>
          ) : null}
        </div>
      </div>

      <nav aria-label={t.t('admin.studio.tabs')} className="-mb-1 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((entry) => {
          const current = entry.id === tab;
          return (
            <Link
              key={entry.id}
              href={studioHref(entry.id, object)}
              aria-current={current ? 'page' : undefined}
              className={`-mb-px inline-flex h-control-base shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-body-sm font-semibold outline-none focus-visible:ring-focus ${
                current ? 'border-primary text-text' : 'border-transparent text-text-2 is-hover:text-text'
              }`}
            >
              {entry.label}
              {entry.count === null ? null : (
                <span className="inline-flex h-5 min-w-5.5 items-center justify-center rounded-full bg-surface-sunken px-1.5 text-caption font-bold text-text-2">
                  {entry.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
