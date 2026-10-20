import { notFound } from 'next/navigation';
import { SectionScreen } from '../../../../components/admin/studio/section-screens';
import { studioPage, type SearchParams } from '../studio-page';

/** `P18/C` — an object's page layouts, a placeholder behind `studio_layouts` (T-0142, D-L194). */
export default async function StudioLayoutsPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await studioPage(await searchParams);
  if (!page.studio.layouts) notFound();
  return <SectionScreen tab="layouts" {...page.common} sections={page.sections} object={page.object} />;
}
