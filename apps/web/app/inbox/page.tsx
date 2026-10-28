import { notFound } from 'next/navigation';
import { featureFlagClient, initialiseFeatureFlags, toEvaluationContext } from '@kasuwa/feature-flags';
import { activeLocale } from '../../lib/locale';

async function inboxEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'crm_inbox',
    false,
    toEvaluationContext({ tenantId: 'process:crm-shell' }),
  );
}

/** P08 inbox route stub (T-0192). */
export default async function InboxPage() {
  if (!(await inboxEnabled())) notFound();
  const { locale } = await activeLocale();
  return <main data-testid="p08-inbox" data-locale={locale} />;
}
