import {
  contactFieldLevel,
  DISPLAY_NAME_PARTS,
  displayNameReadable,
  isWithholdableContactField,
  type ContactFieldAccess,
  type WithholdableContactField,
} from '@kasuwa/domain-core';
import type { ScriptContactField } from './script-publish';
import type { FieldReading } from './script-run-engine';

/**
 * Pure decisions about the contact fields a script reads (T-0124, D-L184),
 * shared by publish (`contactFieldFacts`) and the run (`fieldReader`), so the
 * two can never judge `displayName` differently. No I/O.
 */

/**
 * The script fact for `displayName`, DERIVED from its name parts' facts
 * (D-L68): it has no field_def of its own.
 *   - `withheld` when any part is withheld from any `script.run` set;
 *   - `sensitive` when any part is classified `sensitive` (D-L13 covers
 *     derived fields; D-L184), so it then follows exactly the rules a
 *     sensitive part follows: refused at publish, a branch stops the run;
 *   - `standIn`: a withheld (never a sensitive) name is DISPLAYED as a
 *     translated stand-in (D-L180).
 * A part with no fact fails closed: withheld and sensitive.
 */
export function displayNameFact(
  partFacts: ReadonlyMap<string, ScriptContactField>,
  parts: readonly WithholdableContactField[] = DISPLAY_NAME_PARTS,
): ScriptContactField {
  return {
    sensitive: parts.some((part) => partFacts.get(part)?.sensitive !== false),
    withheld: parts.some((part) => partFacts.get(part)?.withheld !== false),
    standIn: true,
  };
}

/**
 * Whether a branch may read `field` now, for the run's agent in the run's
 * programme: a refusal (`sensitive` before `withheld`), or `null` when the
 * value may be read. `facts` are `contactFieldFacts`, so a `displayName`
 * whose part is sensitive is `sensitive` here exactly as that part would be.
 */
export function fieldGate(
  field: string,
  facts: ReadonlyMap<string, ScriptContactField>,
  access: ContactFieldAccess,
  programmeId: string,
): Extract<FieldReading, { kind: 'withheld' | 'sensitive' }> | null {
  const fact = facts.get(field);
  if (fact === undefined) return { kind: 'withheld' };
  if (fact.sensitive) return { kind: 'sensitive' };
  if (field === 'displayName') {
    // D-L68 (T-0124 I13): the name follows its parts. A branch on a withheld
    // name would disclose it by the side it took, so the run stops instead.
    return displayNameReadable(access, programmeId) ? null : { kind: 'withheld' };
  }
  if (!isWithholdableContactField(field)) return { kind: 'withheld' };
  return contactFieldLevel(access, programmeId, field) === 'none' ? { kind: 'withheld' } : null;
}
