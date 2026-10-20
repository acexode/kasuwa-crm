import { notFound } from 'next/navigation';
import { SectionScreen } from '../../../../components/admin/studio/section-screens';
import { studioPage, type SearchParams } from '../studio-page';

/** `P18/D` — an object's validation rules, a placeholder behind `studio_validation` (T-0142, D-L194). */
export default async function StudioValidationPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await studioPage(await searchParams);
  if (!page.studio.validation) notFound();
  return <SectionScreen tab="validation" {...page.common} sections={page.sections} object={page.object} />;
}
