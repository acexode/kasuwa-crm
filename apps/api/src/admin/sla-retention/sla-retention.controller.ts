import { Body, Get, Param, Put } from '@nestjs/common';
import {
  findProgrammeById,
  findProgrammeRetention,
  findProgrammeSla,
  LegalHoldActiveError,
  replaceProgrammeRetentionWithPrevious,
  replaceProgrammeSlaWithPrevious,
  StalePolicyVersionError,
  type RetentionPolicy,
  type SlaPolicy,
} from '@kasuwa/domain-core';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { staleWrite } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireProgrammePermission } from '../common/admin-permissions';
import { auditRetentionSaved, auditSlaSaved } from './sla-retention.audit';
import { legalHoldActive } from './sla-retention.errors';
import {
  ProgrammeIdParam,
  RetentionPolicyWriteBody,
  SlaPolicyWriteBody,
} from './sla-retention.schemas';

/** `SlaPolicy`: the stored or default policy plus the read-only fields. */
export interface SlaPolicyResponse extends SlaPolicy {
  /** Operating hours have no model yet; null is "we do not know", not "none". */
  operatingHoursSummary: null;
}

/** `RetentionPolicy` plus the read-only `workspaceDefaultDays`. */
export interface RetentionPolicyResponse extends RetentionPolicy {
  /** No workspace-level default exists yet. */
  workspaceDefaultDays: null;
}

/**
 * Programme SLA and retention — T-0028. Contract: docs/api/admin.openapi.yaml,
 * operations getProgrammeSla, updateProgrammeSla, getProgrammeRetention and
 * updateProgrammeRetention; semantics D-L50.
 *
 * Scope: `{programmeId}` is a record identifier looked up inside
 * `currentTx()`, whose programme list came from `user_programme`. An id the
 * caller cannot reach — another tenant's, an unassigned sibling's, nothing at
 * all, or not a uuid — is the one `404 not_found` body, on reads and writes,
 * and is decided BEFORE the body is judged. A reachable programme with no
 * retention policy is that same body.
 *
 * Order of refusals on a write: 404, then 403 `not_permitted` (the `admin`
 * set in the programme or a tenant admin is required, T-0032 / D-L53), then
 * 400, then `409 stale_write`, then `409 legal_hold_active` (D-L50: stale
 * wins).
 *
 * Audited (T-0033): one `updated` event per successful save, in the write's
 * transaction (`sla-retention.audit.ts`); a refused write records nothing.
 *
 * Not built, and said so in the report: the `timeZone` field (no programme
 * time-zone column), and enforcement of any
 * retention period — `callRecordingsDays` in particular is stored and
 * returned but never enforced by Kasuwa (D-T4).
 */
@AdminController('api/v1/admin/programmes/:programmeId')
export class ProgrammeSlaRetentionController {
  /** `GET …/sla` — operationId `getProgrammeSla`. 200 · 401 · 404. */
  @Get('sla')
  async getSla(@Param() params: unknown): Promise<SlaPolicyResponse> {
    const policy = foundOr404(await findProgrammeSla(currentTx(), programmeIdOf(params)));
    return toSlaResponse(policy);
  }

  /** `PUT …/sla` — operationId `updateProgrammeSla`. 200 · 400 · 401 · 403 · 404 · 409. */
  @Put('sla')
  async updateSla(@Param() params: unknown, @Body() body: unknown): Promise<SlaPolicyResponse> {
    const programmeId = await reachableProgrammeId(params);
    await requireProgrammePermission(currentTx(), 'programme_policy.write', programmeId);
    const { version, ...fields } = parseOr400(SlaPolicyWriteBody, body);
    try {
      const tx = currentTx();
      const applied = foundOr404(
        await replaceProgrammeSlaWithPrevious(tx, programmeId, version, fields),
      );
      await auditSlaSaved(tx, programmeId, applied.previous, applied.updated);
      return toSlaResponse(applied.updated);
    } catch (error) {
      throw mapConflict(error);
    }
  }

  /** `GET …/retention` — operationId `getProgrammeRetention`. 200 · 401 · 404. */
  @Get('retention')
  async getRetention(@Param() params: unknown): Promise<RetentionPolicyResponse> {
    const policy = foundOr404(await findProgrammeRetention(currentTx(), programmeIdOf(params)));
    return toRetentionResponse(policy);
  }

  /**
   * `PUT …/retention` — operationId `updateProgrammeRetention`. 200 · 400 ·
   * 401 · 403 · 404 · 409 (`stale_write`, `legal_hold_active`). The first write for
   * a programme with no policy sends `version: 0` (D-L50).
   */
  @Put('retention')
  async updateRetention(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<RetentionPolicyResponse> {
    const programmeId = await reachableProgrammeId(params);
    await requireProgrammePermission(currentTx(), 'programme_policy.write', programmeId);
    const { version, ...fields } = parseOr400(RetentionPolicyWriteBody, body);
    try {
      const tx = currentTx();
      const applied = foundOr404(
        await replaceProgrammeRetentionWithPrevious(tx, programmeId, version, fields),
      );
      await auditRetentionSaved(tx, programmeId, applied.previous, applied.updated);
      return toRetentionResponse(applied.updated);
    } catch (error) {
      throw mapConflict(error);
    }
  }
}

function toSlaResponse(policy: SlaPolicy): SlaPolicyResponse {
  return { ...policy, operatingHoursSummary: null };
}

function toRetentionResponse(policy: RetentionPolicy): RetentionPolicyResponse {
  return { ...policy, workspaceDefaultDays: null };
}

function mapConflict(error: unknown): unknown {
  if (error instanceof StalePolicyVersionError) return staleWrite();
  if (error instanceof LegalHoldActiveError) return legalHoldActive();
  return error;
}

function programmeIdOf(params: unknown): string {
  return parseIdOr404(ProgrammeIdParam, params).programmeId;
}

/** Resolved before the body is judged, so an unreachable programme is 404 whatever was sent. */
async function reachableProgrammeId(params: unknown): Promise<string> {
  const programmeId = programmeIdOf(params);
  foundOr404(await findProgrammeById(currentTx(), programmeId));
  return programmeId;
}
