/**
 * The bulk-invite field on `P01/5.5`: paste many addresses at once, separated
 * by commas or new lines, and see which ones need fixing.
 *
 * The design's inline error is specific — "“bola@ojafoods” is missing an ending
 * like .ng or .com" — because that is the mistake people actually make when
 * typing a company domain from memory. Anything else malformed gets the general
 * message. Nothing here decides whether an address EXISTS; that is not knowable
 * and not asked.
 */

export type AddressProblem = 'missing_ending' | 'invalid';

export interface InviteAddress {
  readonly address: string;
  readonly problem: AddressProblem | null;
}

const SEPARATORS = /[\s,;]+/;
const SHAPE = /^[^\s@]+@[^\s@]+$/;
const WITH_ENDING = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;

export function classifyAddress(address: string): AddressProblem | null {
  if (!SHAPE.test(address)) return 'invalid';
  if (WITH_ENDING.test(address)) return null;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domain.includes('.') && !domain.endsWith('.') ? 'invalid' : 'missing_ending';
}

/** Splits pasted text into addresses, dropping blanks and repeats (case-insensitively). */
export function splitAddresses(text: string, existing: readonly InviteAddress[] = []): InviteAddress[] {
  const seen = new Set(existing.map((entry) => entry.address.toLowerCase()));
  const added: InviteAddress[] = [];
  for (const raw of text.split(SEPARATORS)) {
    const address = raw.trim();
    if (address === '' || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    added.push({ address, problem: classifyAddress(address) });
  }
  return added;
}
