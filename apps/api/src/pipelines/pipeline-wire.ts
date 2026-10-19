import {
  dealRotting,
  type DealCard,
  type PipelineDetail,
  type PipelineStageKind,
  type PipelineSummary,
  type StageTotal,
  type WithholdableDealField,
} from '@kasuwa/domain-core';
import type { CustomWire } from '../custom-fields/custom-values';

/**
 * The wire shapes of listPipelines, getPipeline and getPipelineBoard
 * (records.openapi.yaml: PipelineSummary, Pipeline, PipelineBoard, BoardStage,
 * StageTotal, Deal). Pure, so every rule is unit-tested without a database.
 *
 * MONEY stays a decimal string from the database to the wire (D-L120): no
 * function here does arithmetic on an amount, and nothing here holds a bigint,
 * so JSON.stringify never meets one.
 *
 * WITHHELD FIELDS ARE OMITTED, NEVER NULLED (Deal): a withheld field is absent
 * with its companion and named in `withheldFields`.
 */

export interface PipelineSummaryWire {
  id: string;
  programmeId: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type StageRequirementWire =
  { id: string; kind: 'field'; field: string } | { id: string; kind: 'check'; label: string };

export interface PipelineStageWire {
  id: string;
  name: string;
  kind: PipelineStageKind;
  position: number;
  probabilityBp: number;
  rottingAfterDays: number | null;
  requirements: StageRequirementWire[];
}

export interface PipelineWire extends PipelineSummaryWire {
  stages: PipelineStageWire[];
  transitions: { fromStageId: string; toStageId: string }[];
}

interface DealMoneyWire {
  amountMinor: string;
  currency: string;
}

export interface DealWire {
  id: string;
  programmeId: string;
  pipelineId: string;
  stageId: string;
  version: number;
  name: string;
  amount?: DealMoneyWire | null;
  weightedAmount?: DealMoneyWire | null;
  expectedCloseDate?: string | null;
  ownerUserId?: string | null;
  owner?: { id: string; displayName: string | null } | null;
  primaryContactId?: string | null;
  /** T-0124 I3: `displayName` null when a contact name part is withheld (D-L68). */
  contact?: { id: string; displayName: string | null } | null;
  accountId?: string | null;
  account?: { id: string; name: string } | null;
  nextStep?: string | null;
  stageEnteredAt: string;
  closedAt: string | null;
  rotting: 'fresh' | 'stale' | 'rotting' | null;
  checks: {
    requirementId: string;
    checkedAt: string;
    checkedBy: { id: string; displayName: string | null };
  }[];
  createdAt: string;
  updatedAt: string;
  /** T-0089: custom values readable in the card's programme. */
  custom: Record<string, unknown>;
  /** The board's list (R21), then this card's withheld custom keys as `custom.<key>` (V12). */
  withheldFields: (WithholdableDealField | `custom.${string}`)[];
}

export interface BoardStageWire {
  stageId: string;
  count: number;
  totals?: StageTotal[];
  cards: DealWire[];
  nextCursor: string | null;
}

export interface PipelineBoardWire {
  pipelineId: string;
  closedSince: string;
  withheldFields: WithholdableDealField[];
  stages: BoardStageWire[];
}

export function toPipelineSummaryWire(pipeline: PipelineSummary): PipelineSummaryWire {
  return {
    id: pipeline.id,
    programmeId: pipeline.programmeId,
    name: pipeline.name,
    version: pipeline.version,
    createdAt: pipeline.createdAt.toISOString(),
    updatedAt: pipeline.updatedAt.toISOString(),
  };
}

/** A `field` requirement's api_name as the contract's camelCase DealRequirementField (R12). */
export function requirementFieldWire(apiName: string): string {
  return apiName.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Carries no identifier: 0036's shape CHECK makes this impossible. */
export class RequirementShapeError extends Error {
  constructor() {
    super('A stage requirement has neither its field nor its label');
    this.name = 'RequirementShapeError';
  }
}

export function toPipelineWire(detail: PipelineDetail): PipelineWire {
  return {
    ...toPipelineSummaryWire(detail),
    stages: detail.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      position: stage.position,
      probabilityBp: stage.probabilityBp,
      rottingAfterDays: stage.rottingAfterDays,
      requirements: detail.requirements
        .filter((requirement) => requirement.stageId === stage.id)
        .map((requirement): StageRequirementWire => {
          if (requirement.kind === 'field' && requirement.field !== null) {
            return {
              id: requirement.id,
              kind: 'field',
              field: requirementFieldWire(requirement.field),
            };
          }
          if (requirement.kind === 'check' && requirement.label !== null) {
            return { id: requirement.id, kind: 'check', label: requirement.label };
          }
          throw new RequirementShapeError();
        }),
    })),
    transitions: detail.transitions.map((transition) => ({
      fromStageId: transition.fromStageId,
      toStageId: transition.toStageId,
    })),
    createdAt: detail.createdAt.toISOString(),
    updatedAt: detail.updatedAt.toISOString(),
  };
}

function money(amountMinor: string | null, currency: string | null): DealMoneyWire | null {
  return amountMinor === null || currency === null ? null : { amountMinor, currency };
}

/**
 * One card under field security. `withheld` is the board's list (judged once,
 * in the pipeline's programme), so every card's list equals the board's (R21).
 */
export function toDealWire(
  card: DealCard,
  withheld: readonly WithholdableDealField[],
  /** `displayNameReadable` for the board's programme (T-0124 I3). */
  contactNameReadable: boolean,
  rottingAfterDays: number | null,
  nowMs: number,
  custom: CustomWire,
): DealWire {
  const hidden = new Set(withheld);
  const wire: DealWire = {
    id: card.id,
    programmeId: card.programmeId,
    pipelineId: card.pipelineId,
    stageId: card.stageId,
    version: card.version,
    name: card.name,
    stageEnteredAt: card.stageEnteredAt.toISOString(),
    closedAt: card.closedAt === null ? null : card.closedAt.toISOString(),
    rotting:
      card.closedAt === null ? dealRotting(card.stageEnteredAt, rottingAfterDays, nowMs) : null,
    checks: card.checks.map((check) => ({
      requirementId: check.requirementId,
      checkedAt: check.checkedAt.toISOString(),
      checkedBy: check.checkedBy,
    })),
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
    custom: custom.custom,
    withheldFields: [...withheld, ...(custom.withheld as `custom.${string}`[])],
  };
  if (!hidden.has('amount')) {
    wire.amount = money(card.amountMinor, card.currency);
    wire.weightedAmount = money(card.weightedAmountMinor, card.currency);
  }
  if (!hidden.has('expectedCloseDate')) wire.expectedCloseDate = card.expectedCloseDate;
  if (!hidden.has('ownerUserId')) {
    wire.ownerUserId = card.ownerUserId;
    wire.owner = card.owner;
  }
  if (!hidden.has('primaryContactId')) {
    wire.primaryContactId = card.primaryContactId;
    wire.contact =
      card.contact === null
        ? null
        : {
            id: card.contact.id,
            displayName: contactNameReadable ? card.contact.displayName : null,
          };
  }
  if (!hidden.has('accountId')) {
    wire.accountId = card.accountId;
    wire.account = card.account;
  }
  if (!hidden.has('nextStep')) wire.nextStep = card.nextStep;
  return wire;
}
