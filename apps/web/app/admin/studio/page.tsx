import { notFound } from 'next/navigation';
import { ObjectsScreen } from '../../../components/admin/studio/objects-screen';
import { studioPage, type SearchParams } from './studio-page';

/** `P18/A` — the object manager, a placeholder behind `studio_objects` (T-0142, D-L194). */
export default async function StudioObjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await studioPage(await searchParams);
  if (!page.studio.objects) notFound();
  return <ObjectsScreen {...page.common} relationships={page.studio.relationships} />;
}
