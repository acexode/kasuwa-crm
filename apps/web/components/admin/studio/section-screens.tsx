'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import type { LanguageOption } from '../../auth/language-menu';
import { Icon } from '../../icon';
import { CUSTOM_FIELD_OBJECTS, listCustomFields, type CustomFieldObject } from '../../../lib/custom-fields-api';
import { Panel } from '../panel';
import { useResource } from '../use-resource';
import { ObjectHeader, studioHref, type StudioSections, type StudioTab } from '../custom-fields/object-header';
import {
  STUDIO_INPUT,
  STUDIO_PRIMARY,
  STUDIO_SECONDARY,
  STUDIO_SEGMENT,
  STUDIO_SEGMENTED,
  STUDIO_SEGMENT_OFF,
  STUDIO_SEGMENT_ON,
} from '../custom-fields/studio-classes';
import { StudioFrame } from '../custom-fields/studio-frame';
import { OBJECT_LABEL, TYPE_ICON, TYPE_LABEL } from '../custom-fields/studio-text';

/**
 * The studio's sections with no backend yet (T-0142, D-L194), each behind its
 * own flag and drawn in the export's own empty or disabled state: page
 * layouts and the layout builder (`studio_layouts`), validation rules
 * (`studio_validation`) and record types (`studio_record_types`). Nothing here
 * invents a layout, a rule, a record type or a count. The one live read is the
 * builder's field palette: the object's real custom fields.
 */

interface ScreenProps {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  sections: StudioSections;
  object: CustomFieldObject;
}

function ObjectLinks({ t, object, tab }: { t: Translator; object: CustomFieldObject; tab: StudioTab }) {
  return (
    <nav aria-label={t.t('admin.studio.custom.objects')} className={`${STUDIO_SEGMENTED} max-w-full overflow-x-auto`}>
      {CUSTOM_FIELD_OBJECTS.map((entry) => (
        <Link
          key={entry}
          href={studioHref(tab, entry)}
          aria-current={entry === object ? 'page' : undefined}
          className={`${STUDIO_SEGMENT} ${entry === object ? STUDIO_SEGMENT_ON : STUDIO_SEGMENT_OFF}`}
        >
          {t.t(OBJECT_LABEL[entry])}
        </Link>
      ))}
    </nav>
  );
}

function DashedEmpty({ icon, title, body, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
      <Icon name={icon} size={32} className="text-text-muted" />
      <b className="text-card-title">{title}</b>
      <span className="max-w-md text-body-relaxed text-text-2">{body}</span>
      {children === undefined ? null : <div className="mt-1.5 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

export function SectionScreen({ tab, ...props }: ScreenProps & { tab: 'layouts' | 'validation' }) {
  const { locale, messages, locales, linkedSettings, bell, sections, object } = props;
  const t = createBundleTranslator(locale, messages);
  const objectName = t.t(OBJECT_LABEL[object]);
  return (
    <StudioFrame
      t={t}
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId={tab === 'layouts' ? 'cu-layouts' : 'cu-val'}
      crumbs={[
        { label: objectName, href: studioHref('fields', object) },
        { label: t.t(tab === 'layouts' ? 'admin.studio.tab.layouts' : 'admin.studio.tab.validation') },
      ]}
    >
      <div data-screen={tab === 'layouts' ? 'P18/C' : 'P18/D'} className="flex flex-col gap-5">
        <ObjectHeader t={t} object={object} sections={sections} tab={tab} fieldCount={null} switcher={<ObjectLinks t={t} object={object} tab={tab} />} />
        {tab === 'layouts' ? (
          <DashedEmpty icon="dashboard" title={t.t('admin.studio.layouts.empty.title')} body={t.t('admin.studio.layouts.empty.body', { object: objectName })}>
            <button type="button" disabled className={STUDIO_PRIMARY}>
              <Icon name="add" size={20} />
              {t.t('admin.studio.layouts.new')}
            </button>
            <Link href={`/admin/studio/layouts/builder${object === 'contact' ? '' : `?object=${object}`}`} className={STUDIO_SECONDARY}>
              <Icon name="edit" size={18} />
              {t.t('admin.studio.layouts.openBuilder')}
            </Link>
          </DashedEmpty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 basis-80 text-body-sm text-text-2">{t.t('admin.studio.rules.intro')}</p>
              <button type="button" disabled className={STUDIO_PRIMARY}>
                <Icon name="add" size={20} />
                {t.t('admin.studio.rules.new')}
              </button>
            </div>
            <DashedEmpty icon="rule" title={t.t('admin.studio.rules.empty.title')} body={t.t('admin.studio.rules.empty.body')} />
          </>
        )}
      </div>
    </StudioFrame>
  );
}

export function RecordTypesScreen(props: Omit<ScreenProps, 'object' | 'sections'>) {
  const { locale, messages, locales, linkedSettings, bell } = props;
  const t = createBundleTranslator(locale, messages);
  return (
    <StudioFrame
      t={t}
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="cu-rt"
      crumbs={[{ label: t.t('admin.studio.recordTypes.title') }]}
    >
      <div data-screen="P18/E" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
            <h1 className="text-title">{t.t('admin.studio.recordTypes.title')}</h1>
            <p className="max-w-3xl text-label font-normal text-text-2">{t.t('admin.studio.recordTypes.intro')}</p>
          </div>
          <button type="button" disabled className={STUDIO_PRIMARY}>
            <Icon name="add" size={20} />
            {t.t('admin.studio.recordTypes.new')}
          </button>
        </div>
        <DashedEmpty icon="category" title={t.t('admin.studio.recordTypes.empty.title')} body={t.t('admin.studio.recordTypes.empty.body')} />
      </div>
    </StudioFrame>
  );
}

/**
 * `P18/C1` — the layout builder, empty: the export's toolbar with every action
 * disabled, the palette with this object's real custom fields, an empty canvas
 * under the record header, and an inspector with nothing selected.
 */
export function LayoutBuilderScreen(props: ScreenProps) {
  const { locale, messages, locales, linkedSettings, bell, object } = props;
  const t = createBundleTranslator(locale, messages);
  const objectName = t.t(OBJECT_LABEL[object]);
  const [palette, setPalette] = useState<'fields' | 'components'>('fields');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const list = useResource((signal) => listCustomFields(object, signal), [object]);

  return (
    <StudioFrame
      t={t}
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="cu-layouts"
      crumbs={[
        { label: objectName, href: studioHref('fields', object) },
        { label: t.t('admin.studio.tab.layouts'), href: studioHref('layouts', object) },
        { label: t.t('admin.studio.builder.title') },
      ]}
    >
      <div data-screen="P18/C1" className="-m-4 flex flex-col md:-m-6 xl:-mx-8 xl:-mb-10 xl:-mt-7">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
          <div className="flex min-w-0 flex-1 basis-56 flex-col">
            <span className="text-meta text-text-2">{t.t('admin.studio.builder.eyebrow', { object: objectName })}</span>
            <h1 className="truncate text-card-title">{t.t('admin.studio.builder.title')}</h1>
          </div>
          <div role="group" aria-label={t.t('admin.studio.builder.device')} className={STUDIO_SEGMENTED}>
            {(['desktop', 'mobile'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={device === entry}
                onClick={() => setDevice(entry)}
                className={`${STUDIO_SEGMENT} ${device === entry ? STUDIO_SEGMENT_ON : STUDIO_SEGMENT_OFF}`}
              >
                <Icon name={entry === 'desktop' ? 'desktop_windows' : 'smartphone'} size={20} />
                {t.t(entry === 'desktop' ? 'admin.studio.builder.desktop' : 'admin.studio.builder.mobile')}
              </button>
            ))}
          </div>
          <button type="button" disabled className={STUDIO_SECONDARY}>
            <Icon name="visibility" size={20} />
            {t.t('admin.studio.builder.editing')}
          </button>
          <button type="button" disabled className={STUDIO_SECONDARY}>
            <Icon name="assignment_ind" size={20} />
            {t.t('admin.studio.builder.assign')}
          </button>
          <button type="button" disabled className={STUDIO_PRIMARY}>
            {t.t('admin.studio.builder.save')}
          </button>
        </div>

        <div className="flex min-h-96 flex-col lg:flex-row">
          <aside aria-label={t.t('admin.studio.builder.palette')} className="flex w-full shrink-0 flex-col border-b border-border bg-surface lg:w-layout-studio-palette lg:border-b-0 lg:border-e">
            <div role="tablist" className="flex border-b border-border px-2">
              {(['fields', 'components'] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={palette === entry}
                  onClick={() => setPalette(entry)}
                  className={`-mb-px h-control-base flex-1 border-b-2 text-body-sm font-semibold outline-none focus-visible:ring-focus ${
                    palette === entry ? 'border-primary text-text' : 'border-transparent text-text-2'
                  }`}
                >
                  {t.t(entry === 'fields' ? 'admin.studio.builder.fields' : 'admin.studio.builder.components')}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1 p-3">
              {palette === 'fields' ? (
                <Panel t={t} resource={list}>
                  {(data) => {
                    const active = data.items.filter((item) => item.retiredAt === null);
                    return active.length === 0 ? (
                      <p className="px-1 py-2 text-meta text-text-2">{t.t('admin.studio.builder.noFields')}</p>
                    ) : (
                      <ul className="flex flex-col">
                        {active.map((item) => (
                          <li key={item.id} className="flex h-control-md items-center gap-2 px-1 text-body-sm text-text-2">
                            <Icon name="drag_indicator" size={18} className="text-disabled-text" />
                            <Icon name={TYPE_ICON[item.type]} size={18} />
                            <span data-record-text className="min-w-0 flex-1 truncate">
                              {item.label}
                            </span>
                            <span className="sr-only">{t.t(TYPE_LABEL[item.type])}</span>
                          </li>
                        ))}
                      </ul>
                    );
                  }}
                </Panel>
              ) : (
                <p className="px-1 py-2 text-meta text-text-2">{t.t('admin.studio.builder.componentsSoon')}</p>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col items-center gap-4 bg-surface-sunken p-5">
            <div className={`flex w-full flex-col gap-4 ${device === 'mobile' ? 'max-w-sm' : 'max-w-3xl'}`}>
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-4 py-3.5">
                <span className="text-meta text-text-2">{objectName}</span>
                <span className="inline-flex items-center gap-1 text-caption font-normal text-text-muted">
                  <Icon name="lock" size={14} />
                  {t.t('admin.studio.builder.header')}
                </span>
              </div>
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
                <Icon name="view_agenda" size={28} className="text-text-muted" />
                <b className="text-card-title">{t.t('admin.studio.builder.empty.title')}</b>
                <span className="max-w-md text-body-relaxed text-text-2">{t.t('admin.studio.builder.empty.body')}</span>
              </div>
            </div>
          </div>

          <aside aria-label={t.t('admin.studio.builder.inspector')} className="flex w-full shrink-0 flex-col gap-3 border-t border-border bg-surface p-4 lg:w-layout-studio-inspector lg:border-s lg:border-t-0">
            <span className="flex items-center gap-2 text-label font-bold">
              <Icon name="view_agenda" size={20} />
              {t.t('admin.studio.builder.inspectorTitle')}
            </span>
            <p className="text-meta text-text-2">{t.t('admin.studio.builder.inspectorEmpty')}</p>
            <input type="text" disabled aria-label={t.t('admin.studio.builder.sectionTitle')} placeholder={t.t('admin.studio.builder.sectionTitle')} className={STUDIO_INPUT} />
          </aside>
        </div>
      </div>
    </StudioFrame>
  );
}
