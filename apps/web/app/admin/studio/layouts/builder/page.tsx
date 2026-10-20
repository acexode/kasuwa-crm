import { notFound } from 'next/navigation';
import { LayoutBuilderScreen } from '../../../../../components/admin/studio/section-screens';
import { crmCustomFieldsEnabled } from '../../../../../lib/feature-flags';
import { studioPage, type SearchParams } from '../../studio-page';

/**
 * `P18/C1` — the layout builder, empty, behind `studio_layouts` (T-0142,
 * D-L194). Its palette reads the object's custom fields, so it also needs
 * `crm_custom_fields`.
 */
export default async function StudioLayoutBuilderPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await studioPage(await searchParams);
  if (!page.studio.layouts || !(await crmCustomFieldsEnabled())) notFound();
  return <LayoutBuilderScreen {...page.common} sections={page.sections} object={page.object} />;
}
