'use client';

import type { ReactNode } from 'react';
import type { MessageBundle, Translator } from '@kasuwa/i18n/bundle';
import type { LanguageOption } from '../../auth/language-menu';
import { AdminBreadcrumb, AdminShell } from '../admin-shell';

/**
 * P18's frame (T-0142): the admin console's bar with "Customisation studio"
 * after a divider and the 44px breadcrumb strip under it, as the export draws
 * every studio screen. The settings menu stays: it is the studio's own
 * navigation (Objects, Fields, Page layouts, Validation rules, Record types)
 * and the way back to the rest of the console.
 *
 * The first crumb leads to the object manager where that screen is on, and to
 * the fields screen otherwise, so no crumb is ever a link to a 404.
 */
export function StudioFrame({
  t,
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
  activeSettingId,
  crumbs,
  children,
}: {
  t: Translator;
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  activeSettingId: string;
  /** After "Customisation studio": each a link but the last, the current page. */
  crumbs: readonly { readonly label: string; readonly href?: string }[];
  children: ReactNode;
}) {
  const home = linkedSettings['cu-obj'] ?? linkedSettings['cu-fields'] ?? '/admin';
  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId={activeSettingId}
      section={{ icon: 'design_services', label: t.t('admin.studio.section') }}
      breadcrumb={
        <AdminBreadcrumb
          label={t.t('admin.studio.breadcrumb')}
          steps={[{ label: t.t('admin.studio.section'), href: home }, ...crumbs]}
        />
      }
    >
      {children}
    </AdminShell>
  );
}
