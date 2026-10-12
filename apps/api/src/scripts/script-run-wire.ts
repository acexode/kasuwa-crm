import {
  storedAcknowledgements,
  storedAnswers,
  storedPath,
  type RunAcknowledgement,
  type RunAnswers,
  type RunOutcome,
  type RunStatus,
  type RunStep,
  type StopReason,
} from './script-run-engine';
import type { LiveDisposition, RunnableScriptRecord, RunRecord } from './script-run.repository';
import {
  inLocaleOrder,
  toVersionSummaryWire,
  type StaffRefWire,
  type VersionSummaryWire,
} from './script-wire';

/**
 * The run wire shapes of docs/api/scripting.openapi.yaml (T-0114): ScriptRun,
 * RunnableScript and RunDisposition. Times are UTC ISO 8601 with a `Z`. No
 * tenant id, no count. A run's `answers` are `sensitive`: they go to the
 * run's own agent in these bodies and nowhere else.
 */

export interface ScriptRunWire {
  id: string;
  programmeId: string;
  contactId: string;
  scriptId: string;
  versionId: string;
  versionNumber: number;
  latestVersion: VersionSummaryWire;
  status: RunStatus;
  outcome: RunOutcome | null;
  unacknowledgedComplianceNodeIds: string[];
  endedAtNodeId: string | null;
  stopReason: StopReason | null;
  currentNodeId: string | null;
  path: RunStep[];
  acknowledgements: RunAcknowledgement[];
  answers: RunAnswers;
  startedBy: StaffRefWire;
  startedAt: string;
  completedAt: string | null;
  dispositionId: string | null;
  activityId: string | null;
  followUpTaskId: string | null;
  revision: number;
}

export function toRunWire(run: RunRecord): ScriptRunWire {
  return {
    id: run.id,
    programmeId: run.programmeId,
    contactId: run.contactId,
    scriptId: run.scriptId,
    versionId: run.versionId,
    versionNumber: run.versionNumber,
    latestVersion: toVersionSummaryWire(run.latest),
    status: run.status,
    outcome: run.outcome,
    unacknowledgedComplianceNodeIds: [...run.unacknowledged],
    endedAtNodeId: run.endedAtNodeId,
    stopReason: run.stopReason,
    currentNodeId: run.currentNodeId,
    path: storedPath(run.path),
    acknowledgements: storedAcknowledgements(run.acknowledgements),
    answers: storedAnswers(run.answers),
    startedBy: { id: run.startedBy.id, displayName: run.startedBy.displayName },
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt === null ? null : run.completedAt.toISOString(),
    dispositionId: run.dispositionId,
    activityId: run.activityId,
    followUpTaskId: run.followUpTaskId,
    revision: run.revision,
  };
}

export interface RunnableScriptWire {
  id: string;
  name: string;
  sourceLocale: string;
  translatedLocales: string[];
  latestVersion: VersionSummaryWire;
}

export function toRunnableScriptWire(script: RunnableScriptRecord): RunnableScriptWire {
  return {
    id: script.id,
    name: script.name,
    sourceLocale: script.sourceLocale,
    translatedLocales: inLocaleOrder(script.translatedLocales),
    latestVersion: toVersionSummaryWire(script.latest),
  };
}

export interface RunDispositionWire {
  id: string;
  code: string;
  label: string;
  category: string;
  noteRequired: boolean;
  followUpRequired: boolean;
  position: number;
}

export function toRunDispositionWire(disposition: LiveDisposition): RunDispositionWire {
  return {
    id: disposition.id,
    code: disposition.code,
    label: disposition.label,
    category: disposition.category,
    noteRequired: disposition.noteRequired,
    followUpRequired: disposition.followUpRequired,
    position: disposition.position,
  };
}
