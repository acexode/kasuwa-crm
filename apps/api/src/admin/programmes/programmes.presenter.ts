import type {
  ArchivePreview,
  Programme,
  ProgrammeMember,
  ProgrammeStatus,
} from '@kasuwa/domain-core';

/**
 * Domain records -> the admin contract's response shapes.
 *
 * Every field the spec publishes but no column backs is sent as `null` (where
 * the schema makes it nullable) or left out (where it does not), never as a
 * plausible-looking default. `status` is the `programme.status` column
 * (0012, T-0029); T-0024's constant `active` is gone.
 */

export interface ProgrammeResponse {
  id: string;
  name: string;
  clientName: string | null;
  reference: null;
  countryCode: null;
  status: ProgrammeStatus;
  agentCount: null;
  slaAttainment7d: null;
  retentionSummary: null;
}

export interface ProgrammeDetailResponse extends ProgrammeResponse {
  version: number;
  businessUnitId: string;
  contract: null;
  operating: null;
  people: null;
}

export interface ProgrammeAgentResponse {
  userId: string;
  displayName: string;
  initials: string;
  teamName: null;
  skills: string[];
  /** The telephony adapter is not wired in; null means "we do not know". */
  presence: null;
}

export function toProgrammeResponse(programme: Programme): ProgrammeResponse {
  return {
    id: programme.id,
    name: programme.name,
    clientName: programme.clientName,
    reference: null,
    countryCode: null,
    status: programme.status,
    agentCount: null,
    slaAttainment7d: null,
    retentionSummary: null,
  };
}

/**
 * The `201` body of `createProgramme`. `countryCode` is left out, not `null`
 * and not echoed: it was validated but no column stores it, so `null` would
 * contradict what the caller just sent and an echo would claim it was saved.
 */
export type CreatedProgrammeResponse = Omit<ProgrammeResponse, 'countryCode'>;

export function toCreatedProgrammeResponse(programme: Programme): CreatedProgrammeResponse {
  const { countryCode: _unstored, ...response } = toProgrammeResponse(programme);
  return response;
}

export interface ArchivePreviewResponse {
  agentsLosingAccess: number;
  openInteractionsBecomingReadOnly: number;
  retentionSummary: string | null;
  portalUsersSignedOut: number;
  restorableUntilDays: number;
}

export function toArchivePreviewResponse(preview: ArchivePreview): ArchivePreviewResponse {
  return {
    agentsLosingAccess: preview.agentsLosingAccess,
    openInteractionsBecomingReadOnly: preview.openInteractionsBecomingReadOnly,
    retentionSummary: preview.retentionSummary,
    portalUsersSignedOut: preview.portalUsersSignedOut,
    restorableUntilDays: preview.restorableUntilDays,
  };
}

export function toProgrammeDetailResponse(programme: Programme): ProgrammeDetailResponse {
  return {
    ...toProgrammeResponse(programme),
    version: programme.version,
    businessUnitId: programme.businessUnitId,
    contract: null,
    operating: null,
    people: null,
  };
}

export function toProgrammeAgentResponse(member: ProgrammeMember): ProgrammeAgentResponse {
  return {
    userId: member.userId,
    displayName: member.displayName,
    initials: initialsOf(member.displayName),
    teamName: null,
    skills: member.skills,
    presence: null,
  };
}

/**
 * First letter of the first and last words, upper-cased: "Ngozi Okeke" -> "NO".
 * Iterates code points, not UTF-16 units, so a name starting with a character
 * outside the BMP is not split in half. Never more than the spec's three.
 */
export function initialsOf(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = [first, last]
    .map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? '')))
    .join('');
  return Array.from(letters.toLocaleUpperCase()).slice(0, 3).join('');
}
