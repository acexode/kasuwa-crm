/**
 * @kasuwa/storage-adapter — the one package that names an S3 SDK (ADR-0017,
 * CLAUDE.md 2.8). See ./port.ts for the port, ./keys.ts for how a key is
 * minted, ./s3-store.ts for the store and ./repository.ts for `stored_object`.
 */
export {
  StorageError,
  StoredObjectInputError,
  StoredObjectNotFoundError,
  StoredObjectStateError,
} from './errors';
export type { StorageErrorCode } from './errors';
export { STORAGE_PURPOSES, StorageKey, StoragePrefix, mintStorageKey, tenantStoragePrefix } from './keys';
export type { MintStorageKeyInput, StoragePurpose } from './keys';
export { MIN_PART_BYTES, PRESIGNED_URL_TTL_SECONDS, planParts, selectPlannedParts } from './port';
export type {
  CompletedPart,
  ObjectHead,
  ObjectStore,
  PresignUploadOptions,
  PresignUploadPartsOptions,
  PresignedPart,
  PresignedUpload,
  PutOptions,
} from './port';
export { S3ObjectStore } from './s3-store';
export { StoredObjectRepository } from './repository';
export type {
  CompleteStoredObjectInput,
  CreateStoredObjectInput,
  StoredObjectRecord,
  StoredObjectStatus,
} from './repository';
// TESTS ONLY. Exported so that unit tests in other packages (T-0094) can use
// it; eslint.config.mjs forbids importing it from apps and domain packages.
export { FakeObjectStore } from './fake';
export type { FakeObjectStoreRequest } from './fake';
