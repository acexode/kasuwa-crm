'use client';

import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';

/**
 * Thin P21 commerce screen (T-0171). Catalogue, quotes, approvals and payment
 * status each pass their own title. Invoice and refund frames are not here.
 */
export function CommerceScreen({
  locale,
  messages,
  locales,
  live,
  screen,
  titleId,
  emptyId,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  screen: string;
  titleId: MessageId;
  emptyId: MessageId;
}) {
  const t = createBundleTranslator(locale, messages);
  return (
    <CrmShell t={t} locale={locale} locales={locales} current="" live={live}>
      <section data-screen={screen} className="flex min-w-0 flex-col gap-3 p-4">
        <h1 className="text-title font-bold text-text-1">{t.t(titleId)}</h1>
        <p className="text-body text-text-2">{t.t(emptyId)}</p>
      </section>
    </CrmShell>
  );
}
