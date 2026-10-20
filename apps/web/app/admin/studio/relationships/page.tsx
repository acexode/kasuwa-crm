import { notFound } from 'next/navigation';
import { RelationshipsScreen } from '../../../../components/admin/studio/relationships-screen';
import { studioPage, type SearchParams } from '../studio-page';

/** `P18/A2` — the relationships view, a placeholder behind `studio_relationships` (T-0142, D-L194). */
export default async function StudioRelationshipsPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await studioPage(await searchParams);
  if (!page.studio.relationships) notFound();
  return <RelationshipsScreen {...page.common} objects={page.studio.objects} />;
}
