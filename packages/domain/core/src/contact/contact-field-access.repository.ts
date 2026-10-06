import type { TenantTx } from '@kasuwa/db';
import { loadFieldAccess } from '@kasuwa/metadata-engine';
import { contactFieldAccessFromObjectAccess, type ContactFieldAccess } from './contact-fields';

/**
 * Loads the caller's contact field access (T-0041), through the generic
 * per-object loader since T-0053: `loadFieldAccess(tx, 'contact')` in
 * `@kasuwa/metadata-engine`, which any domain package can reach.
 *
 * Semantics are unchanged and live in the generic loader: the set held in the
 * programme (D-P9), an unsaved cell `edit` (D-L45), a locked set `edit`, a
 * membership with no set the weakest unlocked level, a reachable programme
 * with no membership row `none` for every field. Still ONE round trip per
 * call (auth-availability holds a contacts read to a latency bound), and
 * none at all for a session that reaches no programme.
 *
 * One deliberate difference from T-0041: a tenant with no `contact`
 * definition used to read as "nothing saved, everything edit". Since T-0053
 * every tenant has one (0025 backfill, seed, provisioning) and it cannot be
 * deleted by the application, so its absence is a broken catalogue, and the
 * generic loader rejects rather than failing open.
 */
export async function loadContactFieldAccess(tx: TenantTx): Promise<ContactFieldAccess> {
  const { programmeIds } = tx.session;
  if (programmeIds.length === 0) return new Map();
  const access = await loadFieldAccess(tx, 'contact');
  return contactFieldAccessFromObjectAccess(access, programmeIds);
}
