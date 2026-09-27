import { v7 as uuidv7 } from 'uuid';

/**
 * UUIDv7 primary keys (team/DECISIONS.md D-L08).
 *
 * Time-ordered, so index locality stays sane at the 50M-rows-per-tenant target
 * in the NFRs. Postgres 16 has no native uuidv7(); generate in the application
 * and revisit when the cluster moves to Postgres 18.
 */
export function newId(): string {
  return uuidv7();
}
