import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Controller, Get, Module, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { AuthTenantTransactionInterceptor } from './auth-tenant-transaction.interceptor';

/**
 * The auth pool is confined to AuthModule (T-0049 review, tenancy and security
 * minor 1).
 *
 * The role behind `AUTH_PG_POOL` is the only one that may write the auth
 * tables, so a controller outside the auth module that borrowed the auth
 * interceptor would run its whole request as that role. This proves the
 * attempt does not boot, and that nothing outside AuthModule imports the
 * pool's module.
 *
 * Nothing here connects: `pg` pools open no connection until first used, and
 * `compile()` resolves the dependency graph without running lifecycle hooks
 * (the boot-time role check runs at `init()`).
 */

// Invented, unreachable: compile() never dials them.
const OPTIONS = {
  databaseUrl: 'postgres://kasuwa_app:not-a-secret@127.0.0.1:1/kasuwa',
  authDatabaseUrl: 'postgres://kasuwa_auth:not-a-secret@127.0.0.1:1/kasuwa',
};

@Controller('t0049-borrower')
@UseInterceptors(AuthTenantTransactionInterceptor)
class BorrowingController {
  @Get()
  read(): string {
    return 'should never be served';
  }
}

@Module({ controllers: [BorrowingController] })
class BorrowingFeatureModule {}

describe('AuthModule confines the auth pool (T-0049)', () => {
  it('control: the real app compiles', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(OPTIONS)],
    }).compile();
    await moduleRef.close();
  });

  it('a controller outside AuthModule using the auth interceptor fails to boot', async () => {
    await expect(
      Test.createTestingModule({
        imports: [AppModule.forRoot(OPTIONS), BorrowingFeatureModule],
      }).compile(),
    ).rejects.toThrow(/AuthTenantTransactionInterceptor/);
  });

  it('only auth.module.ts imports AuthDatabaseModule', () => {
    const srcRoot = join(__dirname, '..');
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(srcRoot);
    // Non-vacuous: the walk reaches the app module and the auth module.
    const rel = files.map((file) => relative(srcRoot, file).split(sep).join('/'));
    expect(rel).toEqual(expect.arrayContaining(['app.module.ts', 'auth/auth.module.ts']));

    const importers = files
      .filter((file) => /import\s*\{[^}]*\bAuthDatabaseModule\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcRoot, file).split(sep).join('/'));
    expect(importers).toEqual(['auth/auth.module.ts']);
  });
});
