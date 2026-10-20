import type { MessageId } from '@kasuwa/i18n/bundle';

/**
 * The P06/17 first-pipeline templates (T-0135): copy, not data. No React, so
 * the server page can list their message ids.
 */

export type TemplateId = 'b2b' | 'realEstate' | 'loans' | 'distribution';

export interface Template {
  readonly id: TemplateId;
  readonly icon: 'handshake' | 'apartment' | 'account_balance' | 'inventory_2';
  /** Each stage: its name key, its probability in percent, and whether it has entry requirements. */
  readonly stages: readonly (readonly [string, number, boolean])[];
}

/** The four P06/17 templates, as the export draws them. Copy, not data: each stage name is a translated proposal. */
export const TEMPLATES: readonly Template[] = [
  {
    id: 'b2b',
    icon: 'handshake',
    stages: [
      ['qualified', 10, false],
      ['discovery', 25, false],
      ['proposal', 50, true],
      ['negotiation', 70, true],
      ['contract', 90, true],
      ['won', 100, false],
    ],
  },
  {
    id: 'realEstate',
    icon: 'apartment',
    stages: [
      ['enquiry', 10, false],
      ['inspection', 30, false],
      ['offer', 50, false],
      ['deposit', 75, true],
      ['documentation', 90, true],
      ['handover', 100, false],
    ],
  },
  {
    id: 'loans',
    icon: 'account_balance',
    stages: [
      ['application', 10, false],
      ['kyc', 30, true],
      ['credit', 50, true],
      ['approval', 80, true],
      ['disbursed', 100, false],
    ],
  },
  {
    id: 'distribution',
    icon: 'inventory_2',
    stages: [
      ['lead', 10, false],
      ['sample', 25, false],
      ['trial', 50, false],
      ['terms', 75, true],
      ['stockist', 100, false],
    ],
  },
];

/** A template's message ids, by the convention `pipeline.template.<id>.<part>`; message-ids.ts lists every one. */
export function templateKey(id: string): MessageId {
  return id as MessageId;
}

export const TEMPLATE_MESSAGE_IDS: readonly MessageId[] = TEMPLATES.flatMap((template) => [
  templateKey(`pipeline.template.${template.id}.name`),
  templateKey(`pipeline.template.${template.id}.description`),
  templateKey(`pipeline.template.${template.id}.rule`),
  ...template.stages.map(([stage]) =>
    templateKey(`pipeline.template.${template.id}.stage.${stage}`),
  ),
]);
