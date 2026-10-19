import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * A real SeaweedFS S3 gateway for the object-storage suites (T-0092, ADR-0017).
 *
 * Not a mock, for the reason `containers.ts` gives for Postgres: what the
 * storage adapter must prove (signed lengths, expiry, keys, offboarding) is
 * behaviour of the bucket, and a fake bucket would only agree with whatever
 * the adapter already believes.
 *
 * Same image as docker-compose (`chrislusf/seaweedfs:3.80`, D-L21), but with
 * CREDENTIALLED access: an S3 identity config is copied into the container,
 * so every request must be signed, and an unsigned one is refused. The suite
 * can also mount the repository's own dev identity file (`identityConfig`) to
 * prove that file ends anonymous mode.
 *
 * TWO WAYS IN, ON PURPOSE:
 *   - `endpoint` is the S3 gateway. The adapter under test talks to it.
 *   - `listEntries` reads the FILER's HTTP listing, which is not S3 and needs
 *     no signature. It is how a suite checks what the bucket really holds
 *     without trusting the adapter it is testing: an adapter whose list call
 *     is broken would otherwise "prove" its own deletePrefix.
 *
 * Owned by the lead (T-0092 acceptance). Application code never imports
 * `@kasuwa/testing` (lint-enforced).
 */

const SEAWEEDFS_IMAGE = 'chrislusf/seaweedfs:3.80';
const S3_PORT = 8333;
const FILER_PORT = 8888;
const MASTER_PORT = 9333;
const IDENTITY_PATH = '/etc/seaweedfs/s3.json';

/** Invented, test-only credentials. Never a real key. */
const TEST_ACCESS_KEY_ID = 'kasuwa-test-access';
const TEST_SECRET_ACCESS_KEY = 'kasuwa-test-secret-not-real-0092';

export interface SeaweedFsEntry {
  /** The S3 key, relative to the bucket (no leading slash). */
  key: string;
  size: number;
  /** The filer's extended attributes, as it reports them (values are base64 strings). */
  extended: Record<string, string>;
}

export interface StartedSeaweedFs {
  /** The S3 gateway as this host reaches it, e.g. `http://localhost:49153`. */
  endpoint: string;
  /** Any region string signs against SeaweedFS; this one matches `.env.example`. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The filer's HTTP origin (no auth). For `listEntries`; never for the adapter. */
  filerUrl: string;
  /**
   * Every OBJECT under `prefix` in `bucket`, read from the filer, recursively.
   * In-progress multipart uploads (`.uploads/`) are not objects and are not
   * listed; see `listUploadDirectories`.
   */
  listEntries: (prefix: string) => Promise<SeaweedFsEntry[]>;
  /** The ids of in-progress multipart uploads in `bucket` (the `.uploads/` children). */
  listUploadDirectories: () => Promise<string[]>;
  /** Creates another bucket (for isolation probes). */
  createBucket: (name: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface StartSeaweedFsOptions {
  /** Defaults to `kasuwa-test`. */
  bucket?: string;
  /**
   * The S3 identity config, as JSON text. Defaults to one identity holding
   * `accessKeyId` / `secretAccessKey` with full rights on every bucket.
   */
  identityConfig?: string;
  /** Override the credentials `endpoint` users should sign with (when `identityConfig` is given). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /**
   * `-s3.allowedOrigins`, as docker-compose would pass it. SeaweedFS 3.80 has
   * no per-bucket CORS (PutBucketCors is 501); this gateway-wide list is the
   * only origin control it offers. Unset: SeaweedFS's default, `*`.
   */
  allowedOrigins?: string;
}

function defaultIdentityConfig(): string {
  return JSON.stringify({
    identities: [
      {
        name: 'kasuwa-test',
        credentials: [{ accessKey: TEST_ACCESS_KEY_ID, secretKey: TEST_SECRET_ACCESS_KEY }],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
    ],
  });
}

interface FilerListing {
  Entries?: { FullPath?: string; FileSize?: number; Mode?: number; Extended?: Record<string, string> | null }[] | null;
  LastFileName?: string;
  ShouldDisplayLoadMore?: boolean;
}

const DIRECTORY_BIT = 0x80000000;

async function filerList(filerUrl: string, directory: string): Promise<NonNullable<FilerListing['Entries']>> {
  const all: NonNullable<FilerListing['Entries']> = [];
  let lastFileName = '';
  for (;;) {
    const url = new URL(`${filerUrl}${directory.endsWith('/') ? directory : `${directory}/`}`);
    url.searchParams.set('limit', '1000');
    if (lastFileName !== '') url.searchParams.set('lastFileName', lastFileName);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.status === 404) return all;
    if (!response.ok) {
      throw new Error(`filer listing of ${directory} answered ${response.status}`);
    }
    const listing = (await response.json()) as FilerListing;
    const entries = listing.Entries ?? [];
    all.push(...entries);
    const last = entries.at(-1)?.FullPath;
    if (listing.ShouldDisplayLoadMore !== true || last === undefined) return all;
    lastFileName = last.slice(last.lastIndexOf('/') + 1);
  }
}

async function exec(container: StartedTestContainer, script: string): Promise<{ exitCode: number; output: string }> {
  const result = await container.exec(['sh', '-c', script]);
  return { exitCode: result.exitCode, output: result.output };
}

export async function startSeaweedFs(options: StartSeaweedFsOptions = {}): Promise<StartedSeaweedFs> {
  const bucket = options.bucket ?? 'kasuwa-test';
  const credentials = options.credentials ?? {
    accessKeyId: TEST_ACCESS_KEY_ID,
    secretAccessKey: TEST_SECRET_ACCESS_KEY,
  };

  const container = await new GenericContainer(SEAWEEDFS_IMAGE)
    .withCommand([
      'server',
      '-dir=/data',
      '-s3',
      `-s3.port=${S3_PORT}`,
      `-s3.config=${IDENTITY_PATH}`,
      `-master.port=${MASTER_PORT}`,
      // Small volumes: the default preallocates for 30 GB volumes.
      '-master.volumeSizeLimitMB=64',
      '-volume.port=8080',
      '-filer',
      `-filer.port=${FILER_PORT}`,
      ...(options.allowedOrigins === undefined ? [] : [`-s3.allowedOrigins=${options.allowedOrigins}`]),
    ])
    .withCopyContentToContainer([
      { content: options.identityConfig ?? defaultIdentityConfig(), target: IDENTITY_PATH },
    ])
    .withExposedPorts(S3_PORT, FILER_PORT, MASTER_PORT)
    // The S3 gateway is the last thing up. Any HTTP answer (an unsigned GET is
    // refused with 403) means it is serving.
    .withWaitStrategy(
      Wait.forHttp('/', S3_PORT).forStatusCodeMatching((status) => status > 0),
    )
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const endpoint = `http://${host}:${container.getMappedPort(S3_PORT)}`;
  const filerUrl = `http://${host}:${container.getMappedPort(FILER_PORT)}`;

  const createBucket = async (name: string): Promise<void> => {
    // A bucket is a filer directory under /buckets. `weed shell` creates it
    // through the filer, needing no S3 signature (and no SDK in this package).
    // Bounded retries on the filer's own readiness, never a sleep.
    let last = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await exec(
        container,
        `echo "s3.bucket.create -name ${name}" | weed shell -master=localhost:${MASTER_PORT} 2>&1`,
      );
      last = result.output;
      const listed = await fetch(`${filerUrl}/buckets/`, { headers: { Accept: 'application/json' } })
        .then(async (response) => (response.ok ? ((await response.json()) as FilerListing) : {}))
        .catch(() => ({}) as FilerListing);
      if ((listed.Entries ?? []).some((entry) => entry.FullPath === `/buckets/${name}`)) return;
    }
    throw new Error(`could not create bucket ${name}: ${last.slice(-500)}`);
  };

  await createBucket(bucket);

  const listEntries = async (prefix: string): Promise<SeaweedFsEntry[]> => {
    const root = `/buckets/${bucket}`;
    const found: SeaweedFsEntry[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await filerList(filerUrl, directory)) {
        const fullPath = entry.FullPath ?? '';
        const key = fullPath.slice(root.length + 1);
        if (key === '.uploads' || key.startsWith('.uploads/')) continue;
        if (((entry.Mode ?? 0) & DIRECTORY_BIT) !== 0) {
          // Descend only where the prefix can still match.
          const asDir = `${key}/`;
          if (asDir.startsWith(prefix) || prefix.startsWith(asDir)) await walk(fullPath);
        } else if (key.startsWith(prefix)) {
          found.push({ key, size: entry.FileSize ?? 0, extended: entry.Extended ?? {} });
        }
      }
    };
    await walk(root);
    return found.sort((a, b) => a.key.localeCompare(b.key));
  };

  const listUploadDirectories = async (): Promise<string[]> => {
    const entries = await filerList(filerUrl, `/buckets/${bucket}/.uploads`);
    return entries.map((entry) => (entry.FullPath ?? '').split('/').at(-1) ?? '').filter((id) => id !== '');
  };

  return {
    endpoint,
    region: 'af-south-1',
    bucket,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    filerUrl,
    listEntries,
    listUploadDirectories,
    createBucket,
    stop: async () => {
      await container.stop();
    },
  };
}
