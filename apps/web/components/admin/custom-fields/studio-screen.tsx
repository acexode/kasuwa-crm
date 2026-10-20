'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../auth/button-classes';
import type { LanguageOption } from '../../auth/language-menu';
import { CUSTOM_FIELD_OBJECTS, type CustomFieldObject } from '../../../lib/custom-fields-api';
import { Dialog } from '../dialog';
import { useUnsavedGuard } from '../use-unsaved-guard';
import { ObjectHeader, type StudioSections } from './object-header';
import { ObjectPanel, type EditorFlags } from './object-panel';
import { STUDIO_SEGMENT, STUDIO_SEGMENTED, STUDIO_SEGMENT_OFF, STUDIO_SEGMENT_ON } from './studio-classes';
import { StudioFrame } from './studio-frame';
import { OBJECT_LABEL } from './studio-text';

/**
 * `P18/B` — the customisation studio for custom fields (T-0090), drawn to the
 * export's object page (T-0142): the studio frame, the object header and its
 * tabs, the toolbar with the limit meter, the field table, and the field
 * editor docked beside it (a drawer below 1280).
 *
 * Tenant-wide, never programme-scoped (ADR-0008): a definition belongs to the
 * tenant, so it sits in the admin console with the settings menu's "Fields"
 * entry current.
 *
 * One control per standard object, the contract's four in its order, contact
 * first. A lead is a contact (D-P17), so there is no separate control for one.
 * The export picks the object in the object manager; here the four sit in the
 * header as a segmented control, the export's own List/Relationships style.
 * The design's parts that no read serves yet are drawn only behind their
 * flags (D-L194), in their empty or disabled state.
 */

export function StudioScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
  sections,
  editorFlags,
  initialObject,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  sections: StudioSections;
  editorFlags: EditorFlags;
  initialObject: CustomFieldObject;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();
  const [object, setObject] = useState<CustomFieldObject>(initialObject);
  const [count, setCount] = useState<number | null>(null);
  const [form, setForm] = useState({ dirty: false, saving: false });
  // Where the admin was going when the guard stopped them: another object, or a link.
  const [leaving, setLeaving] = useState<{ object: CustomFieldObject } | { href: string } | null>(null);
  const onFormState = useCallback((state: { dirty: boolean; saving: boolean }) => setForm(state), []);

  // Links (the settings menu, the tabs, field security) ask first while a form holds changes.
  useUnsavedGuard(form.dirty, (href) => setLeaving({ href }));

  const show = (next: CustomFieldObject) => {
    setCount(null);
    setObject(next);
  };
  const choose = (next: CustomFieldObject) => {
    if (next === object || form.saving) return;
    if (form.dirty) setLeaving({ object: next });
    else show(next);
  };
  const leave = () => {
    const target = leaving;
    setLeaving(null);
    setForm({ dirty: false, saving: false });
    if (target === null) return;
    if ('object' in target) show(target.object);
    else router.push(target.href);
  };

  const switcher = (
    <div role="group" aria-label={t.t('admin.studio.custom.objects')} className={`${STUDIO_SEGMENTED} max-w-full overflow-x-auto`}>
      {CUSTOM_FIELD_OBJECTS.map((entry) => {
        const current = entry === object;
        return (
          <button
            key={entry}
            type="button"
            data-object-tab={entry}
            aria-pressed={current}
            aria-disabled={form.saving && !current}
            onClick={() => choose(entry)}
            className={`${STUDIO_SEGMENT} ${current ? STUDIO_SEGMENT_ON : STUDIO_SEGMENT_OFF}`}
          >
            {t.t(OBJECT_LABEL[entry])}
          </button>
        );
      })}
    </div>
  );

  return (
    <StudioFrame
      t={t}
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="cu-fields"
      crumbs={[{ label: t.t(OBJECT_LABEL[object]) }]}
    >
      <ObjectPanel
        key={object}
        t={t}
        locale={locale}
        object={object}
        flags={editorFlags}
        onFormState={onFormState}
        onCount={setCount}
        header={<ObjectHeader t={t} object={object} sections={sections} tab="fields" fieldCount={count} switcher={switcher} />}
      />

      {leaving === null ? null : (
        <Dialog
          testId="discard-dialog"
          icon="edit_note"
          tone="warning"
          title={t.t('admin.studio.custom.discard.title')}
          body={t.t('admin.studio.custom.discard.body')}
          closeLabel={t.t('admin.dialog.close')}
          onClose={() => setLeaving(null)}
          footer={
            <>
              <button type="button" onClick={leave} className={SECONDARY_BUTTON}>
                {t.t('admin.studio.custom.discard.confirm')}
              </button>
              <button type="button" onClick={() => setLeaving(null)} className={PRIMARY_BUTTON}>
                {t.t('admin.studio.custom.discard.keep')}
              </button>
            </>
          }
        />
      )}
    </StudioFrame>
  );
}
