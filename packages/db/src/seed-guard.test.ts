import { describe, expect, it } from 'vitest';
import { runSeed } from './seed';

/**
 * The seed refuses to run against anything but a local database.
 *
 * This is not hygiene. The seed installs five working users whose shared
 * password and TOTP secrets are committed to this repository and exported from
 * this very package, so running it against a reachable environment turns a
 * fixture into a published credential with a valid second factor.
 *
 * The guard used to live on the `db:seed` CLI, which protected only the callers
 * who happened to come through the CLI. `runSeed` is exported, so a script, a
 * test or a future deployment tool could import it and the check would never
 * run. These tests assert it is on the function.
 *
 * They need no database: the guard throws before a connection is opened, which
 * is itself the property worth having.
 */
describe('runSeed host guard', () => {
  it('refuses a remote host', async () => {
    await expect(
      runSeed({ connectionString: 'postgres://kasuwa_migrator@db.staging.internal:5432/kasuwa' }),
    ).rejects.toThrow(/refuses to run against a non-local host/u);
  });

  it('says why, not just no', async () => {
    // An error that only says "refused" gets worked around. One that says the
    // credentials are in the repository gets read.
    await expect(
      runSeed({ connectionString: 'postgres://kasuwa_migrator@10.0.0.5:5432/kasuwa' }),
    ).rejects.toThrow(/committed to the\s+repository/u);
  });

  it('refuses a hostname that merely contains "localhost"', async () => {
    await expect(
      runSeed({ connectionString: 'postgres://kasuwa_migrator@localhost.evil.test:5432/kasuwa' }),
    ).rejects.toThrow(/refuses to run against a non-local host/u);
  });

  it('judges the host pg will use: a ?host= override is refused (T-0117 M3)', async () => {
    await expect(
      runSeed({
        connectionString: 'postgres://kasuwa_migrator@localhost:5432/kasuwa?host=db.t0117.invalid',
      }),
    ).rejects.toThrow(/refuses to run against a non-local host/u);
  });

  it('refuses a connection string that names no host', async () => {
    await expect(runSeed({ connectionString: 'postgres:///kasuwa' })).rejects.toThrow(
      /refuses to run against a non-local host/u,
    );
  });

  it('never echoes the host', async () => {
    await expect(
      runSeed({ connectionString: 'postgres://kasuwa_migrator@db.t0117-echo.invalid:5432/kasuwa' }),
    ).rejects.not.toThrow(/t0117-echo/u);
  });

  it('allows the local forms the harness and developers actually use', async () => {
    // These must get past the guard. They will then fail to connect, which is
    // the proof that the guard let them through rather than short-circuiting.
    for (const host of ['localhost', '127.0.0.1']) {
      await expect(
        runSeed({ connectionString: `postgres://kasuwa_migrator@${host}:1/kasuwa` }),
      ).rejects.not.toThrow(/refuses to run against a non-local host/u);
    }
  });
});
