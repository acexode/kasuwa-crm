import { DESIGN_VERSION } from '@kasuwa/ui';
import { MESSAGE_IDS, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { ComponentsTwoGallery } from '../../../components/design/components-2-gallery';
import { activeLocale } from '../../../lib/locale';

/**
 * The component gallery, part 2 (T-0129), beside /design/components and
 * /design/tokens: the table, menus, overlays and feedback of
 * `@kasuwa/ui/components`, laid out like the v1.1 Components and Patterns
 * pages. Unflagged and data-free, like its siblings.
 *
 * It follows the device's light or dark setting; `?locale=ar` renders it
 * right to left.
 */

/** Ids the gallery borrows from other screens rather than duplicating. */
const SHARED_IDS: readonly MessageId[] = [
  'activities.related.contact',
  'admin.audit.clearAll',
  'admin.audit.export.cancel',
  'admin.dialog.close',
  'admin.fls.bulk.clear',
  'admin.sla.col.channel',
  'auth.panel.channel.email',
  'auth.panel.channel.sms',
  'auth.panel.channel.whatsapp',
  'design.components.pill.escalated',
  'design.components.pill.open',
  'design.components.pill.pending',
  'design.components.pill.resolved',
  'design.components.sample.delete',
  'design.components.sample.undo',
  'design.components.segmented.comfortable',
  'design.components.segmented.dense',
  'record.activity.type.call',
  'record.form.save',
  'records.action.import',
  'records.col.phones',
  'records.filter.owner',
  'records.filter.status',
  'records.retry',
  'scripting.builder.field.value',
];

const GALLERY_IDS: readonly MessageId[] = [
  ...MESSAGE_IDS.filter((id) => id.startsWith('design.components2.')),
  ...SHARED_IDS,
];

export default async function ComponentsTwoPage() {
  const { locale } = await activeLocale();
  return (
    <ComponentsTwoGallery
      locale={locale}
      messages={bundleMessages(locale, GALLERY_IDS)}
      version={DESIGN_VERSION}
    />
  );
}
