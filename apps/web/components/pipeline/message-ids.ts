import type { MessageId } from '@kasuwa/i18n/bundle';
import { REQUIREMENT_FIELDS } from '../../lib/pipelines-api';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';

/**
 * The strings P06 needs, resolved on the SERVER (T-0109).
 *
 * **No `'use client'` in this file, ever** — a server component importing a
 * client module's array gets a proxy, which fails at request time and not at
 * compile time (`app/client-boundary.test.ts`). Only these strings cross the
 * wire; the catalogues stay on the server.
 *
 * `message-ids.test.ts` checks every id the pipeline sources name is here.
 */

/** Every `records.error.<code>` the P06 operations can answer, plus the transport's own. */
export const PIPELINE_ERROR_IDS: readonly MessageId[] = [
  'records.error.validation_failed',
  'records.error.not_authenticated',
  'records.error.not_permitted',
  'records.error.not_found',
  'records.error.stale_write',
  'records.error.too_many_requests',
  'records.error.service_unavailable',
  'records.error.internal_error',
  'records.error.transition_not_allowed',
  'records.error.requirements_unmet',
  'records.error.network',
];

const SHARED: readonly MessageId[] = [...CRM_SHELL_MESSAGE_IDS, ...PIPELINE_ERROR_IDS, 'records.retry', 'records.loadMore', 'records.loadingMore'];

export const PIPELINE_INDEX_MESSAGE_IDS: readonly MessageId[] = [
  ...SHARED,
  'pipeline.index.title',
  'pipeline.index.intro',
  'pipeline.index.label',
  'pipeline.index.loading',
  'pipeline.index.error',
  'pipeline.index.empty.title',
  'pipeline.index.empty.body',
];

export const PIPELINE_MESSAGE_IDS: readonly MessageId[] = [
  ...SHARED,
  'records.nav.deals',
  'records.locked',
  'records.owner.former',
  'records.filter.label',
  'records.filter.clearAll',
  'records.offline.title',
  'records.offline.never',
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
  'pipeline.index.back',
  'pipeline.view.label',
  'pipeline.view.board',
  'pipeline.view.list',
  'pipeline.newDeal',
  'pipeline.loading',
  'pipeline.board.label',
  'pipeline.board.hint',
  'pipeline.board.error',
  'pipeline.board.empty.title',
  'pipeline.board.empty.body',
  'pipeline.notFound.title',
  'pipeline.notFound.body',
  'pipeline.column.countLabel',
  'pipeline.column.empty',
  'pipeline.column.weighted',
  'pipeline.won.since',
  'pipeline.card.move',
  'pipeline.card.noAmount',
  'pipeline.card.unassigned',
  'pipeline.rotting.stale',
  'pipeline.rotting.rotting',
  'pipeline.search.label',
  'pipeline.search.placeholder',
  'pipeline.filter.owner',
  'pipeline.filter.owner.any',
  'pipeline.filter.owner.me',
  'pipeline.filter.currency',
  'pipeline.filter.currency.any',
  'pipeline.filter.closeFrom',
  'pipeline.filter.closeTo',
  'pipeline.filter.won',
  'pipeline.filter.won.days',
  'pipeline.offline.synced',
  // The list view (loaded when first opened, but its strings ride with the page).
  'pipeline.sort.label',
  'pipeline.sort.updated',
  'pipeline.sort.created',
  'pipeline.sort.name',
  'pipeline.sort.waiting',
  'pipeline.list.label',
  'pipeline.list.deal',
  'pipeline.list.stage',
  'pipeline.list.loading',
  'pipeline.list.error',
  'pipeline.list.noResults',
  // The move sheet and the requirement prompt.
  'pipeline.dialog.close',
  'pipeline.cancel',
  'pipeline.move.title',
  'pipeline.move.from',
  'pipeline.move.options',
  'pipeline.move.none',
  'pipeline.move.gated',
  'pipeline.move.notAllowed',
  'pipeline.move.moved',
  'pipeline.move.unmet',
  'pipeline.move.field_not_editable',
  'pipeline.prompt.title',
  'pipeline.prompt.intro',
  'pipeline.prompt.met',
  'pipeline.prompt.locked',
  'pipeline.prompt.conflict',
  'pipeline.prompt.stale',
  'pipeline.prompt.confirm',
  'pipeline.prompt.search',
  'pipeline.prompt.results',
  'pipeline.prompt.noMatches',
  ...REQUIREMENT_FIELDS.map((field) => `pipeline.field.${field}` as MessageId),
  'pipeline.field.name',
  'pipeline.field.currency',
  'pipeline.field.owner',
  // The create form.
  'pipeline.create.title',
  'pipeline.create.intro',
  'pipeline.create.amountHint',
  'pipeline.create.currency.choose',
  'pipeline.create.error.name',
  'pipeline.create.error.amount',
  'pipeline.create.error.currency',
  'pipeline.create.submit',
  'pipeline.created',
];
