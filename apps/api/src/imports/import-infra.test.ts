import { describe, expect, it } from 'vitest';
import { AdminError } from '../admin/common/admin-errors';
import { ImportsEnabledGuard, importsEnabled, isObjectStore } from './import-infra';

describe('the crm_import gate (T-0094, D-L166)', () => {
  it('follows the flag when main.ts passes it, whatever infrastructure is given', () => {
    expect(importsEnabled({ crmImport: false, redisUrl: 'redis://r:6379', objectStore: {} })).toBe(false);
    expect(importsEnabled({ crmImport: true })).toBe(true);
  });

  it('without the flag, an in-process boot opts in only with Redis AND an object store', () => {
    expect(importsEnabled({})).toBe(false);
    expect(importsEnabled({ redisUrl: 'redis://r:6379' })).toBe(false);
    expect(importsEnabled({ objectStore: {} })).toBe(false);
    expect(importsEnabled({ redisUrl: 'redis://r:6379', objectStore: {} })).toBe(true);
  });

  it('off, the guard answers the never-existed 404', () => {
    expect(new ImportsEnabledGuard(true).canActivate()).toBe(true);
    let thrown: unknown;
    try {
      new ImportsEnabledGuard(false).canActivate();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdminError);
    expect((thrown as AdminError).getStatus()).toBe(404);
    expect((thrown as AdminError).getResponse()).toMatchObject({ code: 'not_found' });
  });

  it('accepts only an object carrying every ObjectStore method', () => {
    expect(isObjectStore({})).toBe(false);
    expect(isObjectStore(null)).toBe(false);
  });
});
