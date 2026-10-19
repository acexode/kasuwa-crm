import { describe, expect, it } from 'vitest';
import { apiEnv, isStorageEnv, storageEnv, webEnv, workerEnv } from './index';

const SECRET = 'unit-secret-not-real-0092';
const DEV = {
  NODE_ENV: 'development',
  S3_ENDPOINT: 'http://seaweedfs.internal.example:8333',
  S3_PUBLIC_ENDPOINT: 'http://localhost:59000',
  S3_REGION: 'af-south-1',
  S3_BUCKET: 'kasuwa-local',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'unit-access-not-real',
  S3_SECRET_ACCESS_KEY: SECRET,
};

function messageOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('it did not throw');
}

describe('storageEnv', () => {
  it('parses a development store, defaulting SSE to AES256', () => {
    const env = storageEnv(DEV);
    expect(env).toMatchObject({
      endpoint: 'http://seaweedfs.internal.example:8333',
      publicEndpoint: 'http://localhost:59000',
      region: 'af-south-1',
      bucket: 'kasuwa-local',
      forcePathStyle: true,
      sseMode: 'AES256',
    });
    expect(env.credentials?.secretAccessKey).toBe(SECRET);
  });

  it('keeps the credentials out of JSON and spreads', () => {
    const env = storageEnv(DEV);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(JSON.stringify({ ...env })).not.toContain(SECRET);
  });

  it('parses AWS with workload identity: no endpoint, no keys, path style off', () => {
    const env = storageEnv({ NODE_ENV: 'production', S3_REGION: 'af-south-1', S3_BUCKET: 'kasuwa-za-1' });
    expect(env).toMatchObject({ endpoint: undefined, publicEndpoint: undefined, forcePathStyle: false });
    expect(env.credentials).toBeUndefined();
  });

  it('defaults the public endpoint to the internal one', () => {
    const { S3_PUBLIC_ENDPOINT: _dropped, ...rest } = DEV;
    expect(storageEnv(rest).publicEndpoint).toBe(DEV.S3_ENDPOINT);
  });

  it('refuses half a credential pair without echoing it', () => {
    const { S3_ACCESS_KEY_ID: _dropped, ...rest } = DEV;
    const message = messageOf(() => storageEnv(rest));
    expect(message).toMatch(/S3_ACCESS_KEY_ID/);
    expect(message).not.toContain(SECRET);
  });

  it('refuses SSE off outside development and test, and aws:kms everywhere', () => {
    expect(() => storageEnv({ ...DEV, S3_SSE_MODE: 'off' })).not.toThrow();
    expect(() => storageEnv({ ...DEV, NODE_ENV: 'test', S3_SSE_MODE: 'off' })).not.toThrow();
    expect(messageOf(() => storageEnv({ ...DEV, NODE_ENV: 'production', S3_SSE_MODE: 'off' }))).toContain('S3_SSE_MODE');
    const { NODE_ENV: _unset, ...noNodeEnv } = DEV;
    expect(messageOf(() => storageEnv({ ...noNodeEnv, S3_SSE_MODE: 'off' }))).toContain('S3_SSE_MODE');
    expect(messageOf(() => storageEnv({ ...DEV, S3_SSE_MODE: 'aws:kms' }))).toContain('S3_SSE_MODE');
  });
});

describe('storageEnv endpoint schemes and branding (D-L155)', () => {
  const prod = { NODE_ENV: 'production', S3_REGION: 'af-south-1', S3_BUCKET: 'kasuwa-za-1' };

  it('requires https outside development and test', () => {
    expect(() => storageEnv({ ...prod, S3_ENDPOINT: 'https://s3.example' })).not.toThrow();
    expect(messageOf(() => storageEnv({ ...prod, S3_ENDPOINT: 'http://s3.example' }))).toContain('S3_ENDPOINT');
    expect(messageOf(() => storageEnv({ ...prod, S3_PUBLIC_ENDPOINT: 'http://s3.example' }))).toContain(
      'S3_PUBLIC_ENDPOINT',
    );
    expect(() => storageEnv({ ...DEV, NODE_ENV: 'test' })).not.toThrow();
  });

  it.each(['ftp://s3.example', 'file:///etc/passwd', 'javascript:alert(1)'])('refuses %s everywhere', (url) => {
    expect(messageOf(() => storageEnv({ ...DEV, S3_ENDPOINT: url }))).toContain('S3_ENDPOINT');
  });

  it('brands only what it returned', () => {
    const env = storageEnv(DEV);
    expect(isStorageEnv(env)).toBe(true);
    expect(isStorageEnv({ ...env })).toBe(false);
    expect(isStorageEnv({ region: 'af-south-1', bucket: 'x' })).toBe(false);
  });
});

describe('the SSE rule in the API and worker schemas', () => {
  const server = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://u:p@db.example:5432/k',
    DATABASE_AUTH_URL: 'postgres://u:p@db.example:5432/k',
  };
  // The worker requires its relay connection (T-0098); the API refuses it.
  const worker = { ...server, DATABASE_RELAY_URL: 'postgres://u:p@db.example:5432/k' };

  it('accepts off in development and refuses an invalid mode', () => {
    expect(() => apiEnv({ ...server, S3_SSE_MODE: 'off' })).not.toThrow();
    expect(() => workerEnv({ ...worker, S3_SSE_MODE: 'off' })).not.toThrow();
    expect(messageOf(() => apiEnv({ ...server, S3_SSE_MODE: 'aws:kms' }))).toContain('S3_SSE_MODE');
    expect(messageOf(() => workerEnv({ ...worker, S3_SSE_MODE: 'aws:kms' }))).toContain('S3_SSE_MODE');
  });
});

describe('the web schema', () => {
  it('returns the public storage origin and refuses the internal endpoint', () => {
    expect(webEnv({ KASUWA_WEB_ORIGIN: 'http://localhost:3000', KASUWA_API_INTERNAL_URL: 'http://127.0.0.1:3001', S3_PUBLIC_ENDPOINT: 'http://localhost:59000' }).S3_PUBLIC_ENDPOINT).toBe('http://localhost:59000');
    const message = messageOf(() => webEnv({ S3_ENDPOINT: `http://internal-${SECRET}.example` }));
    expect(message).toContain('S3_ENDPOINT');
    expect(message).not.toContain(SECRET);
  });
});
