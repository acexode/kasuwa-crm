import { randomUUID } from 'node:crypto';
import type { TenantTx } from '@kasuwa/db';
import { StorageError } from './errors';

/**
 * Storage keys (ADR-0017 Decision 2, T-0092 suite K and R2).
 *
 *   tenant/<tenantId>/programme/<programmeId>/<purpose>/<fileId>
 *
 * A key is MINTED, never built from text:
 *   - the tenant comes from `tx.session.tenantId`, the session that
 *     `withTenantTransaction` resolved, and from nowhere else;
 *   - the programme must be one of `tx.session.programmeIds`;
 *   - the purpose is one of STORAGE_PURPOSES (a closed enum);
 *   - the fileId is a fresh server UUID.
 * There is no filename, extension or user text in a key, and any extra input
 * (a tenantId, a fileId, a filename) is ignored.
 *
 * A StorageKey is a class instance with PRIVATE fields. That makes it nominal
 * to TypeScript (a string, or an object literal with a `toString`, is not
 * assignable to it) and checkable at RUN TIME (`#text in value`), which a
 * branded string is not: the brand is erased, and the callers that will hand
 * keys back (T-0094's handlers) cannot be trusted to have kept the type. Every
 * store method calls `assertMintedKey` before it makes a request, so a forged
 * key (a string, a look-alike object, a spread or prototype clone) is refused
 * before anything reaches the bucket.
 *
 * The text is reachable through `String(key)` because the store needs it and
 * the suite reads it. It is redacted from `JSON.stringify` and from Node's
 * `util.inspect`, so logging a key object by mistake prints no path.
 */

export const STORAGE_PURPOSES = Object.freeze(['import'] as const);
export type StoragePurpose = (typeof STORAGE_PURPOSES)[number];

/** Canonical lower-case UUID text, as Postgres prints a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isStoragePurpose(value: unknown): value is StoragePurpose {
  return typeof value === 'string' && (STORAGE_PURPOSES as readonly string[]).includes(value);
}

/** Only this module can construct a key or a prefix: the token is never exported. */
const MINT: unique symbol = Symbol('kasuwa.storage.mint');

const REDACTED_KEY = '[StorageKey]';
const REDACTED_PREFIX = '[StoragePrefix]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

interface KeyParts {
  readonly tenantId: string;
  readonly programmeId: string;
  readonly purpose: StoragePurpose;
  readonly fileId: string;
}

export class StorageKey {
  readonly #text: string;
  readonly #parts: KeyParts;

  /** @internal Not constructible outside this module: the token is private. */
  constructor(token: symbol, parts: KeyParts) {
    if (token !== MINT) {
      throw new StorageError('storage_key_refused', 'a storage key can only be minted from a session');
    }
    for (const id of [parts.tenantId, parts.programmeId, parts.fileId]) {
      if (!isCanonicalUuid(id)) {
        throw new StorageError('storage_key_refused', 'a storage key part is not a canonical uuid');
      }
    }
    if (!isStoragePurpose(parts.purpose)) {
      throw new StorageError('storage_purpose_refused', 'the storage purpose is not allowed');
    }
    this.#parts = Object.freeze({ ...parts });
    this.#text = `tenant/${parts.tenantId}/programme/${parts.programmeId}/${parts.purpose}/${parts.fileId}`;
    Object.freeze(this);
  }

  /** True only for a key this module minted. A string, a look-alike or a clone is false. */
  static isMinted(value: unknown): value is StorageKey {
    return typeof value === 'object' && value !== null && #text in value;
  }

  toString(): string {
    return this.#text;
  }

  /** The parts, for this package's own use (the fake store and the repository). */
  get parts(): KeyParts {
    return this.#parts;
  }

  toJSON(): string {
    return REDACTED_KEY;
  }

  [INSPECT](): string {
    return REDACTED_KEY;
  }
}

export class StoragePrefix {
  readonly #text: string;

  /** @internal */
  constructor(token: symbol, tenantId: string) {
    if (token !== MINT || !isCanonicalUuid(tenantId)) {
      throw new StorageError('storage_prefix_refused', 'a storage prefix can only be minted for a tenant id');
    }
    this.#text = `tenant/${tenantId}/`;
    Object.freeze(this);
  }

  static isMinted(value: unknown): value is StoragePrefix {
    return typeof value === 'object' && value !== null && #text in value;
  }

  toString(): string {
    return this.#text;
  }

  toJSON(): string {
    return REDACTED_PREFIX;
  }

  [INSPECT](): string {
    return REDACTED_PREFIX;
  }
}

export interface MintStorageKeyInput {
  readonly programmeId: string;
  readonly purpose: StoragePurpose;
}

/**
 * Mints a fresh key in one of the session's programmes. Synchronous and writes
 * nothing. Throws a StorageError (never naming the input) when the programme
 * is not the session's or the purpose is not allowed.
 */
export function mintStorageKey(tx: TenantTx, input: MintStorageKeyInput): StorageKey {
  return mintKeyWithId(tx, input, randomUUID());
}

/**
 * The repository's mint: the same rules, with the fileId it will insert as the
 * row's id (R1: fileId IS stored_object.id). Not exported from the package.
 */
export function mintKeyWithId(tx: TenantTx, input: MintStorageKeyInput, fileId: string): StorageKey {
  const tenantId = tx.session.tenantId;
  const { programmeId, purpose } = input as { programmeId?: unknown; purpose?: unknown };
  if (!isStoragePurpose(purpose)) {
    throw new StorageError('storage_purpose_refused', 'the storage purpose is not allowed');
  }
  if (!isCanonicalUuid(programmeId) || !tx.session.programmeIds.includes(programmeId)) {
    throw new StorageError(
      'storage_programme_out_of_scope',
      'the programme is not one this session can reach',
    );
  }
  return new StorageKey(MINT, { tenantId, programmeId, purpose, fileId });
}

/**
 * Rebuilds the key of a stored_object row that the repository has just read IN
 * SCOPE (R1). The parts come from the row's own columns, never a parsed
 * string. Not exported from the package.
 */
export function keyForStoredRow(row: KeyParts): StorageKey {
  return new StorageKey(MINT, row);
}

/** `tenant/<tenantId>/`, the offboarding prefix for every tier (D-L128 Q2). Refuses a non-UUID. */
export function tenantStoragePrefix(tenantId: string): StoragePrefix {
  return new StoragePrefix(MINT, tenantId);
}

export function assertMintedKey(value: unknown): asserts value is StorageKey {
  if (!StorageKey.isMinted(value)) {
    throw new StorageError('storage_key_refused', 'not a storage key minted by this adapter');
  }
}

export function assertMintedPrefix(value: unknown): asserts value is StoragePrefix {
  if (!StoragePrefix.isMinted(value)) {
    throw new StorageError('storage_prefix_refused', 'not a storage prefix minted by this adapter');
  }
}
