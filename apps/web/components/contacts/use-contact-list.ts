'use client';

import { listContacts, type Contact } from '../../lib/records-api';
import { toListQuery, type ContactView } from './contacts-model';
import { useKeysetList, type KeysetList } from '../records/use-keyset-list';

/**
 * The contacts list (P04/02, P04/06): `listContacts` through the keyset list
 * every P04 screen shares (`components/records/use-keyset-list.ts`), which is
 * where the in-memory-only, search-never-in-the-URL and stale-answer rules
 * live. The view is the filter state; contacts have no sort control.
 */

export type ContactList = KeysetList<Contact, ContactView>;

/** Module-level, so the list's effect sees one stable function. */
function fetchContacts(q: string, view: ContactView, cursor?: string) {
  return listContacts(toListQuery(q, view.filters, cursor, view.custom));
}

export function useContactList(q: string, view: ContactView): ContactList {
  return useKeysetList(q, view, fetchContacts);
}
