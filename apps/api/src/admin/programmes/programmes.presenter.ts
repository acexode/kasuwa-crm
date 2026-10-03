import type { Programme, ProgrammeMember } from '@kasuwa/domain-core';

/**
 * Domain records -> the admin contract's response shapes.
 *
 * Every field the spec publishes but no column backs is sent as `null` (where
 * the schema makes it nullable) or left out (where it does not), never as a
 * plausible-looking default. `status` is the exception the lead ruled on:
 * `programme` has no lifecycle column, every programme that exists is live, so
 * it is the constant `active` until the migration that adds one.
 */

export interface ProgrammeResponse {
  id: string;
  name: string;
  clientName: string | null;
  reference: null;
  countryCode: null;
  status: 'active';
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
    status: 'active',
    agentCount: null,
    slaAttainment7d: null,
    retentionSummary: null,
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
