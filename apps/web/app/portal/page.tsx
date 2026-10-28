import { notFound } from 'next/navigation';
import { featureFlagClient, initialiseFeatureFlags, toEvaluationContext } from '@kasuwa/feature-flags';
import { activeLocale } from '../../lib/locale';

async function portalEnabled(): Promise<boolean> {
  await initialiseFeatureFlags();
  return featureFlagClient().getBooleanValue(
    'client_portal',
    false,
    toEvaluationContext({ tenantId: 'process:crm-shell' }),
  );
}

/** P23 portal route stub (T-0184). */
export default async function PortalPage() {
  if (!(await portalEnabled())) notFound();
  const { locale } = await activeLocale();
  return <main data-testid="p23-portal" data-locale={locale} />;
}
