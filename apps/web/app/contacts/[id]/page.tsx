import { bundleMessages } from '@kasuwa/i18n';
import { RecordView } from './record-view';
import { activeLocale } from '../../../lib/locale';

/**
 * Scaffolding, not a screen — see the note in `record-view.tsx`. It exists so
 * the tenancy e2e test can tamper with a WEB url, which is the half T-0008
 * could not write.
 */
export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { locale } = await activeLocale();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <RecordView
        id={id}
        locale={locale}
        messages={bundleMessages(locale, [
          'auth.slow.loading',
          'auth.error.network',
          'notFound.title',
          'notFound.body',
        ])}
      />
    </div>
  );
}
