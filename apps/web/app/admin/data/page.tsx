import { notFound, redirect } from 'next/navigation';
import { dataPage } from '../../../lib/data-management';

/** `/admin/data` — the Data management area opens on its first live section (T-0141). */
export default async function DataIndexPage() {
  const { flags, sections } = await dataPage();
  if (!flags.area) notFound();
  const first = (['import', 'duplicates', 'migration', 'exports', 'requests'] as const).find((section) => sections[section]);
  if (first === undefined) notFound();
  redirect(`/admin/data/${first}`);
}
