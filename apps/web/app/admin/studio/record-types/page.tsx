import { notFound } from 'next/navigation';
import { RecordTypesScreen } from '../../../../components/admin/studio/section-screens';
import { studioPage, type SearchParams } from '../studio-page';

/** `P18/E` — record types, a placeholder behind `studio_record_types` (T-0142, D-L194). */
export default async function StudioRecordTypesPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await studioPage(await searchParams);
  if (!page.studio.recordTypes) notFound();
  return <RecordTypesScreen {...page.common} />;
}
