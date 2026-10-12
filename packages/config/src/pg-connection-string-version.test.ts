import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-0117 review m6: the database-target guards judge a connection string with
 * `@kasuwa/config`'s own `pg-connection-string`. They are only right if that
 * is the SAME parser `pg` uses: two versions could disagree on `?host=`,
 * `?password=` or decoding, and the guard would then judge a different target
 * from the one the driver connects to. This resolves the package from
 * `@kasuwa/config` and from `pg` (as `@kasuwa/db` resolves pg) and compares
 * the versions their package.json files declare.
 *
 * `pg-connection-string`'s `exports` map does not expose `./package.json`, so
 * each is found by resolving the entry point and walking up to the
 * package.json that names the package.
 */

const CONFIG_PACKAGE_JSON = resolve(__dirname, '..', 'package.json');
const DB_PACKAGE_JSON = resolve(__dirname, '..', '..', 'db', 'package.json');

function packageJsonOf(fromFile: string, name: string): { path: string; version: string } {
  let dir = dirname(createRequire(fromFile).resolve(name));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === name && typeof parsed.version === 'string') {
        return { path: candidate, version: parsed.version };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no package.json naming ${name} above its entry point`);
    }
    dir = parent;
  }
}

describe("@kasuwa/config's pg-connection-string is the one pg uses", () => {
  it('resolves to the same version from @kasuwa/config and from pg', () => {
    const fromConfig = packageJsonOf(CONFIG_PACKAGE_JSON, 'pg-connection-string');
    const pg = packageJsonOf(DB_PACKAGE_JSON, 'pg');
    const fromPg = packageJsonOf(pg.path, 'pg-connection-string');
    expect(fromConfig.version, `config: ${fromConfig.path}; pg: ${fromPg.path}`).toBe(
      fromPg.version,
    );
  });
});
