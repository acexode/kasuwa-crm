'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { LINK, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../auth/button-classes';
import type { LanguageOption } from '../../auth/language-menu';
import { CUSTOM_FIELD_OBJECTS, type CustomFieldObject } from '../../../lib/custom-fields-api';
import { AdminShell } from '../admin-shell';
import { Dialog } from '../dialog';
import { useUnsavedGuard } from '../use-unsaved-guard';
import { ObjectPanel } from './object-panel';
import { OBJECT_LABEL } from './studio-text';

/**
 * `P18/B` — the customisation studio for custom fields, in the admin console.
 *
 * Tenant-wide, never programme-scoped (ADR-0008): a definition belongs to the
 * tenant, so it sits in the admin console and not in the CRM shell, with the
 * settings menu's "Fields" entry current.
 *
 * One control per standard object, the contract's four in its order, contact
 * first. A lead is a contact (D-P17), so there is no separate control for one.
 * Everything the design offers that the contract or the task overrules — custom
 * objects, layouts, validation rules, delete and restore, a type change, usage
 * counts, plan meters, other currencies — is absent on purpose.
 */

export function StudioScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();
  const [object, setObject] = useState<CustomFieldObject>('contact');
  const [form, setForm] = useState({ dirty: false, saving: false });
  // Where the admin was going when the guard stopped them: another object, or a link.
  const [leaving, setLeaving] = useState<{ object: CustomFieldObject } | { href: string } | null>(null);
  const onFormState = useCallback((state: { dirty: boolean; saving: boolean }) => setForm(state), []);

  // Links (the settings menu, field security) ask first while a form holds changes.
  useUnsavedGuard(form.dirty, (href) => setLeaving({ href }));

  const choose = (next: CustomFieldObject) => {
    if (next === object || form.saving) return;
    if (form.dirty) setLeaving({ object: next });
    else setObject(next);
  };
  const leave = () => {
    const target = leaving;
    setLeaving(null);
    setForm({ dirty: false, saving: false });
    if (target === null) return;
    if ('object' in target) setObject(target.object);
    else router.push(target.href);
  };

  return (
    <AdminShell locale={locale} messages={messages} locales={locales} linkedSettings={linkedSettings} bell={bell} activeSettingId="cu-fields">
      <div data-screen="P18/B" className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-body-sm font-semibold text-text-muted">{t.t('admin.studio.custom.eyebrow')}</span>
          <h1 className="text-h2">{t.t('admin.studio.custom.title')}</h1>
          <p className="max-w-prose text-body-md text-text-2">{t.t('admin.studio.custom.intro')}</p>
          {/* Who may read or edit a custom field is the field-security matrix's to say, not the studio's. */}
          <Link href="/admin/field-security" className={`${LINK} w-fit`}>
            {t.t('admin.studio.custom.fieldSecurity')}
          </Link>
        </div>

        <div role="group" aria-label={t.t('admin.studio.custom.objects')} className="flex flex-wrap gap-2">
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
                className={`flex min-h-touch items-center rounded-md border px-3 text-body-md font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                  current ? 'border-primary bg-primary-soft text-primary-text' : 'border-border bg-surface text-text'
                }`}
              >
                {t.t(OBJECT_LABEL[entry])}
              </button>
            );
          })}
        </div>

        <ObjectPanel key={object} t={t} locale={locale} object={object} onFormState={onFormState} />

        {leaving === null ? null : (
          <Dialog
            testId="discard-dialog"
            icon="warning"
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
      </div>
    </AdminShell>
  );
}
