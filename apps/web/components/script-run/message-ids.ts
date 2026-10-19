import type { MessageId } from '@kasuwa/i18n/bundle';
import { NODE_TYPES } from '../../lib/script-graph';
import { NETWORK, SCRIPTING_ERROR_CODES } from '../../lib/scripting-http';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { FIELD_ERRORS } from './run-model';

/**
 * The strings the P10 agent screens need, resolved on the SERVER (T-0116).
 *
 * **No `'use client'` in this file, ever**: a server page importing a client
 * module's array gets a proxy, which fails at request time and not at compile
 * time (`app/client-boundary.test.ts`). Only these strings cross the wire.
 */

/** Every code a scripting operation can answer with, as `scripting.error.<code>`. */
export const SCRIPTING_ERROR_MESSAGE_IDS: readonly MessageId[] = [...SCRIPTING_ERROR_CODES, NETWORK].map(
  (code) => `scripting.error.${code}` as MessageId,
);

/** The start control and its menu, on the contact record (P10/04). Added to the record's bundle only with the flag on. */
export const START_SCRIPT_MESSAGE_IDS: readonly MessageId[] = [
  'scripting.start',
  'scripting.start.menu',
  'scripting.start.close',
  'scripting.start.loading',
  'scripting.start.failed',
  'scripting.start.empty',
  'scripting.start.version',
  'scripting.start.more',
  ...SCRIPTING_ERROR_MESSAGE_IDS,
];

export const STOP_MESSAGE_IDS: readonly MessageId[] = ['scripting.run.stopped.field_withheld', 'scripting.run.stopped.sensitive_field'];

export const OUTCOME_MESSAGE_IDS: readonly MessageId[] = [
  'scripting.run.outcome.completed',
  'scripting.run.outcome.interrupted',
  'scripting.run.outcome.superseded',
];

export const NODE_TYPE_MESSAGE_IDS: readonly MessageId[] = NODE_TYPES.map((type) => `scripting.nodeType.${type}` as MessageId);

export const SCRIPT_RUN_MESSAGE_IDS: readonly MessageId[] = [
  ...CRM_SHELL_MESSAGE_IDS,
  'notFound.title',
  'notFound.body',
  'records.offline.title',
  'records.offline.never',
  'record.offline',
  'records.error.network',
  'records.retry',
  'admin.slow.title',
  'admin.slow.body',
  'admin.slow.switch',
  ...NODE_TYPE_MESSAGE_IDS,
  ...STOP_MESSAGE_IDS,
  ...OUTCOME_MESSAGE_IDS,
  ...FIELD_ERRORS.map((code) => `scripting.run.fieldError.${code}` as MessageId),
  'scripting.run.loading',
  'scripting.run.unavailable',
  'scripting.run.eyebrow',
  'scripting.run.with',
  'scripting.run.contactUnavailable',
  'scripting.run.banner',
  'scripting.run.language',
  'scripting.run.steps',
  'scripting.run.step.current',
  'scripting.run.step.done',
  'scripting.run.placeholder',
  // T-0124 I13 (D-L180): a withheld {contact.displayName}'s stand-in.
  'scripting.run.withheldName',
  'scripting.run.fallback',
  'scripting.run.hint',
  'scripting.run.next',
  'scripting.run.choices',
  'scripting.run.answered',
  'scripting.run.acknowledge',
  'scripting.run.acknowledged',
  'scripting.run.compliance.note',
  'scripting.run.form.note',
  'scripting.run.optional',
  'scripting.run.amountIn',
  'scripting.run.choose',
  'scripting.run.complete',
  'scripting.run.endEarly',
  'scripting.run.done.title',
  'scripting.run.done.disposition',
  'scripting.run.done.unknownDisposition',
  'scripting.run.done.followUp',
  'scripting.run.done.followUpBooked',
  'scripting.run.done.unread',
  'scripting.run.sheet.title.completed',
  'scripting.run.sheet.title.interrupted',
  'scripting.run.sheet.body.interrupted',
  'scripting.run.sheet.dispositions',
  'scripting.run.sheet.loading',
  'scripting.run.sheet.failed',
  'scripting.run.sheet.suggested',
  'scripting.run.sheet.noteRequired',
  'scripting.run.sheet.followUpRequired',
  'scripting.run.sheet.more',
  'scripting.run.sheet.note',
  'scripting.run.sheet.noteOptional',
  'scripting.run.sheet.followUp',
  'scripting.run.sheet.followUpHint',
  'scripting.run.sheet.chooseFirst',
  'scripting.run.sheet.noteMissing',
  'scripting.run.sheet.followUpMissing',
  'scripting.run.sheet.followUpInvalid',
  'scripting.run.sheet.lost',
  'scripting.run.sheet.save',
  'scripting.run.sheet.saving',
  'scripting.run.sheet.retry',
  'scripting.run.sheet.cancel',
  ...SCRIPTING_ERROR_MESSAGE_IDS,
];
