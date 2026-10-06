import { describe, expect, it } from 'vitest';
import { loadMigrations } from './migrate';
import { ACCOUNT_MAX_DEPTH, ACCOUNT_TIERS, account } from './schema';
import { STANDARD_OBJECT_CATALOGUE } from './standard-object-catalogue';

/**
 * Migration 0026 (T-0054) carries frozen copies of four lists that also live
 * in code: the eight new standard account fields (the backfill), their names
 * (the clash pre-check and the stray check), the tier codes and the depth cap.
 * The acceptance suite proves the database agrees with the seed; this proves,
 * without a database, that the SQL and the code were written from one list.
 */

const migration = loadMigrations().find((row) => row.id.startsWith('0026_'));

function sql(): string {
  if (migration === undefined) throw new Error('no 0026_*.sql migration');
  return migration.sql;
}

function captured(pattern: RegExp, what: string): string {
  const match = pattern.exec(sql());
  const value = match?.[1];
  if (value === undefined) throw new Error(`0026: ${what} not found`);
  return value;
}

/** The quoted literals of a SQL list: `'a', 'b'` -> ['a', 'b']. */
const literals = (list: string): string[] =>
  [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');

const accountCatalogue = STANDARD_OBJECT_CATALOGUE.find((object) => object.apiName === 'account');
const accountFields = accountCatalogue?.fields ?? [];
/** Fields 0026 added: every account field after `name` (0025's). */
const addedFields = accountFields.filter((field) => field.apiName !== 'name');

describe('migration 0026 and the code agree (T-0054)', () => {
  it('the catalogue has account.name and the eight contract fields, in that order', () => {
    expect(accountFields.map((field) => field.apiName)).toEqual([
      'name',
      'owner_user_id',
      'industry',
      'tier',
      'tags',
      'phones',
      'state',
      'lga',
      'parent_account_id',
    ]);
  });

  it('the backfill literal is exactly the catalogue’s new account fields', () => {
    const frozen = JSON.parse(
      captured(/new_fields constant jsonb := '(\[[\s\S]*?\])';/, 'the backfill literal'),
    ) as unknown;
    expect(frozen).toEqual(
      addedFields.map((field) => ({
        api_name: field.apiName,
        label: field.label,
        type: field.type,
        classification: field.classification,
        is_required: field.isRequired,
        config: field.config,
      })),
    );
  });

  it('the clash pre-check names exactly the new fields', () => {
    expect(
      literals(captured(/new_fields constant text\[\] := ARRAY\[([\s\S]*?)\];/, 'the clash list')),
    ).toEqual(addedFields.map((field) => field.apiName));
  });

  it('the stray check allows exactly the catalogue’s account fields', () => {
    expect(
      literals(
        captured(/account_standard constant text\[\] := ARRAY\[([\s\S]*?)\];/, 'the stray list'),
      ),
    ).toEqual(accountFields.map((field) => field.apiName));
  });

  it('classifies phones as pii (D-L74) and nothing else on account above none', () => {
    expect(
      accountFields
        .filter((field) => field.classification !== 'none')
        .map((field) => [field.apiName, field.classification]),
    ).toEqual([['phones', 'pii']]);
  });

  it('the tier CHECK lists exactly ACCOUNT_TIERS', () => {
    expect(
      literals(captured(/account_tier_check\s+CHECK \(tier IN \(([^)]*)\)\)/, 'the tier CHECK')),
    ).toEqual([...ACCOUNT_TIERS]);
  });

  it('the hierarchy guard caps depth at ACCOUNT_MAX_DEPTH', () => {
    expect(Number(captured(/max_depth constant integer := (\d+);/, 'the depth cap'))).toBe(
      ACCOUNT_MAX_DEPTH,
    );
    expect(ACCOUNT_MAX_DEPTH).toBe(5);
  });

  it('src/schema.ts mirrors a column for every standard account field', () => {
    const columns = new Set(
      Object.values(account as unknown as Record<string, { name?: unknown }>)
        .map((column) => column?.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    expect(
      accountFields.map((field) => field.apiName).filter((name) => !columns.has(name)),
    ).toEqual([]);
  });
});
