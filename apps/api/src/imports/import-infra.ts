import { HttpStatus } from '@nestjs/common';
import {
  IMPORT_JOB_NAMES,
  IMPORT_JOB_OPTIONS,
  IMPORT_QUEUES,
  ImportJobPayload,
  redisConnectionOptions,
  type ImportQueueName,
} from '@kasuwa/domain-core';
import { StoredObjectRepository, type ObjectStore } from '@kasuwa/storage-adapter';
import { Queue } from 'bullmq';
import { AdminError } from '../admin/common/admin-errors';

/**
 * What the import API needs beyond the database (T-0094 suite interface A):
 * the BullMQ queues it enqueues on, and the object store it presigns,
 * completes and heads through (always via StoredObjectRepository, never the
 * store directly). Both are optional AppModule options, so every suite that
 * does not import still boots; without them the import routes answer 503.
 */

export const IMPORT_QUEUES_TOKEN = Symbol('IMPORT_QUEUES');
export const STORED_OBJECTS_TOKEN = Symbol('STORED_OBJECTS');

export interface ImportQueueAction {
  readonly queue: ImportQueueName;
  readonly payload: ImportJobPayload;
  readonly delayMs?: number;
}

export interface ImportQueues {
  enqueue(action: ImportQueueAction): Promise<void>;
  close(): Promise<void>;
}

const unavailable = () =>
  new AdminError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'The service is temporarily unavailable. Try again shortly.',
  );

/**
 * One BullMQ Queue per import queue, for the app's lifetime. The payload is
 * re-parsed before it is sent, so nothing but the three ids can reach Redis,
 * and the options are fixed numbers.
 */
export class BullImportQueues implements ImportQueues {
  readonly #queues: Map<ImportQueueName, Queue>;

  constructor(redisUrl: string) {
    const connection = redisConnectionOptions(redisUrl);
    this.#queues = new Map(IMPORT_QUEUES.map((name) => [name, new Queue(name, { connection })]));
  }

  async enqueue(action: ImportQueueAction): Promise<void> {
    const queue = this.#queues.get(action.queue);
    if (queue === undefined) throw unavailable();
    const payload = ImportJobPayload.parse(action.payload);
    try {
      await queue.add(IMPORT_JOB_NAMES[action.queue], payload, {
        ...IMPORT_JOB_OPTIONS,
        ...(action.delayMs === undefined ? {} : { delay: action.delayMs }),
      });
    } catch {
      // A Redis error can name the host; it is dropped, never logged.
      throw unavailable();
    }
  }

  async close(): Promise<void> {
    for (const queue of this.#queues.values()) await queue.close();
  }
}

/** No Redis configured: every import write that would enqueue is a 503. */
export class DisabledImportQueues implements ImportQueues {
  async enqueue(): Promise<void> {
    throw unavailable();
  }

  async close(): Promise<void> {
    // nothing to close
  }
}

const STORE_METHODS = [
  'put',
  'getStream',
  'head',
  'delete',
  'deletePrefix',
  'presignUpload',
  'presignUploadParts',
  'completeUpload',
  'abortUpload',
] as const;

/** True for an object carrying every ObjectStore method (the boot option is `unknown`). */
export function isObjectStore(value: unknown): value is ObjectStore {
  if (typeof value !== 'object' || value === null) return false;
  const methods = value as Record<string, unknown>;
  return STORE_METHODS.every((name) => typeof methods[name] === 'function');
}

/**
 * The stored-object repository over the configured store, or null without
 * one. A value that is not an ObjectStore refuses to boot rather than failing
 * at the first upload.
 */
export function storedObjectsFor(store: unknown): StoredObjectRepository | null {
  if (store === undefined) return null;
  if (!isObjectStore(store)) throw new Error('AppModule: objectStore is not an ObjectStore');
  return new StoredObjectRepository(store);
}

export function requireStoredObjects(repository: StoredObjectRepository | null): StoredObjectRepository {
  if (repository === null) throw unavailable();
  return repository;
}
