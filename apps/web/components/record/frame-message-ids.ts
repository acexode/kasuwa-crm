import type { MessageId } from '@kasuwa/i18n/bundle';

/**
 * The strings of the P05 record frame (T-0134), resolved on the SERVER like
 * every record's ids. No `'use client'` here, ever: a server component
 * importing a client module's array gets a proxy that fails at request time.
 */

/** What the shared timeline draws (`record-timeline.tsx`): every record that shows one names these. */
export const TIMELINE_FRAME_MESSAGE_IDS: readonly MessageId[] = [
  'record.timeline.today',
  'record.timeline.yesterday',
  'record.timeline.filterEmpty',
  'record.timeline.internal',
];

/** The frame every P05 record draws: breadcrumb, actions, layout, details groups, timeline card, not-found. */
export const RECORD_FRAME_MESSAGE_IDS: readonly MessageId[] = [
  ...TIMELINE_FRAME_MESSAGE_IDS,
  'record.breadcrumb',
  'record.actions',
  'record.action.more',
  'record.action.moreLabel',
  'record.action.log',
  'record.action.edit',
  'record.section.insights',
  'record.section.related',
  'record.section.details',
  'record.section.activity',
  'record.sections',
  'record.field.created',
  'record.field.programme',
  'record.owner',
  'record.chip.since',
  'record.timeline.title',
  'record.timeline.zone',
  'record.timeline.filter',
  'record.timeline.filter.all',
  'record.timeline.filter.calls',
  'record.timeline.filter.notes',
  'record.timeline.filter.tasks',
  'record.timeline.filter.meetings',
  'record.timeline.filter.changes',
  'record.notFound.hint',
  'records.channel.whatsapp',
  'records.channel.sms',
  'records.channel.email',
];

/** The flags a record's placeholders follow, as the server page read them. */
export interface PlaceholderFlags {
  readonly composer: boolean;
  readonly aiSummary: boolean;
  readonly aiNba: boolean;
  readonly call: boolean;
  readonly related: boolean;
  readonly identity: boolean;
  readonly addresses: boolean;
  readonly follow: boolean;
}

/** The strings of the D-L194 placeholders that are on: with a flag off, its strings do not ship. */
export function placeholderMessageIds(flags: PlaceholderFlags): MessageId[] {
  const any = Object.values(flags).some(Boolean);
  return [
    ...(any ? (['record.action.soon'] as const) : []),
    ...(flags.call ? (['record.action.call'] as const) : []),
    ...(flags.follow ? (['record.action.follow'] as const) : []),
    ...(flags.composer
      ? ([
          'record.activity.type.note',
          'record.composer.label',
          'record.composer.channels',
          'record.composer.closed.title',
          'record.composer.closed.body',
          'record.composer.noTemplates',
          'record.composer.placeholder.whatsapp',
          'record.composer.placeholder.sms',
          'record.composer.placeholder.email',
          'record.composer.placeholder.note',
          'record.composer.message',
          'record.composer.attach',
          'record.composer.quickReply',
          'record.composer.aiDraft',
          'record.composer.hint.note',
          'record.composer.hint.off',
          'record.composer.saveNote',
          'record.composer.send',
          'record.composer.sendTemplate',
        ] as const)
      : []),
    ...(flags.aiSummary ? (['record.ai.title', 'record.ai.happened', 'record.ai.empty', 'record.ai.footer'] as const) : []),
    ...(flags.aiNba ? (['record.nba.title', 'record.nba.empty', 'record.nba.body', 'record.nba.draft'] as const) : []),
    ...(flags.related
      ? ([
          'record.action.newDeal',
          'record.action.newTicket',
          'record.action.paymentLink',
          'record.related.deals',
          'record.related.tickets',
          'record.related.quotes',
          'record.related.invoices',
          'record.related.campaigns',
          'record.related.empty',
          'record.timeline.filter.payments',
          'record.timeline.filter.einvoices',
        ] as const)
      : []),
    ...(flags.identity
      ? ([
          'record.identity.label',
          'record.identity.title',
          'record.identity.nin',
          'record.identity.bvn',
          'record.identity.notChecked',
          'record.identity.footer',
        ] as const)
      : []),
    ...(flags.addresses
      ? ([
          'record.addresses.title',
          'record.addresses.add',
          'record.addresses.location',
          'record.addresses.empty',
          'record.field.state',
          'record.field.lga',
        ] as const)
      : []),
  ];
}
