import type { HttpException } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import type * as DomainCore from '@kasuwa/domain-core';
import type * as Permissions from '@kasuwa/permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductFor, updateProductFor, upsertPriceBookEntryFor } from './catalogue.service';

/**
 * D-L210 (T-0164): catalogue writes need `catalogue.write`; scope is judged
 * first (404), then the permission (403). No database: the domain-core
 * repository and the grants are mocked.
 */

const PROGRAMME = '11111111-0000-4000-8000-000000164001';
const OTHER = '11111111-0000-4000-8000-000000164002';
const PRODUCT = '11111111-0000-4000-8000-000000164003';
const BOOK = '11111111-0000-4000-8000-000000164004';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  findProduct: vi.fn(),
  findBook: vi.fn(),
  allowed: vi.fn<(action: string, programmeId: string) => boolean>(),
}));

vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainCore>()),
  createProduct: mocks.create,
  updateProduct: mocks.update,
  upsertPriceBookEntry: mocks.upsert,
  findProductById: mocks.findProduct,
  findPriceBookById: mocks.findBook,
}));

vi.mock('@kasuwa/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof Permissions>()),
  loadGrants: () => Promise.resolve({}),
  canProgramme: (_grants: unknown, action: string, programmeId: string) =>
    mocks.allowed(action, programmeId),
}));

const tx = {
  session: {
    tenantId: '11111111-0000-4000-8000-000000164000',
    userId: 'u',
    programmeIds: [PROGRAMME],
  },
} as unknown as TenantTx;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code };
  }
}

describe('catalogue writes need catalogue.write (D-L210)', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.allowed.mockReturnValue(false);
  });

  it('create: 403 without the action, and nothing is written', async () => {
    const result = await outcome(() =>
      createProductFor(tx, { programmeId: PROGRAMME }, { name: 'X' }),
    );
    expect(result).toMatchObject({ code: 'not_permitted' });
    expect(mocks.allowed).toHaveBeenCalledWith('catalogue.write', PROGRAMME);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('create: a programme outside the session is 404 before the permission check', async () => {
    const result = await outcome(() => createProductFor(tx, { programmeId: OTHER }, { name: 'X' }));
    expect(result).toMatchObject({ code: 'not_found' });
    expect(mocks.allowed).not.toHaveBeenCalled();
  });

  it('update: 404 when the product is out of scope, 403 when in scope without the action', async () => {
    mocks.findProduct.mockResolvedValueOnce(null);
    expect(
      await outcome(() => updateProductFor(tx, { productId: PRODUCT }, { name: 'n' })),
    ).toMatchObject({
      code: 'not_found',
    });
    expect(mocks.allowed).not.toHaveBeenCalled();

    mocks.findProduct.mockResolvedValueOnce({ id: PRODUCT, programmeId: PROGRAMME });
    expect(
      await outcome(() => updateProductFor(tx, { productId: PRODUCT }, { name: 'n' })),
    ).toMatchObject({
      code: 'not_permitted',
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('upsert: 404 when the book is out of scope, 403 when in scope without the action', async () => {
    const body = { productId: PRODUCT, amountMinor: '100', currency: 'NGN' };
    mocks.findBook.mockResolvedValueOnce(null);
    expect(
      await outcome(() => upsertPriceBookEntryFor(tx, { priceBookId: BOOK }, body)),
    ).toMatchObject({
      code: 'not_found',
    });
    expect(mocks.allowed).not.toHaveBeenCalled();

    mocks.findBook.mockResolvedValueOnce({ id: BOOK, programme_id: PROGRAMME, currency: 'NGN' });
    expect(
      await outcome(() => upsertPriceBookEntryFor(tx, { priceBookId: BOOK }, body)),
    ).toMatchObject({
      code: 'not_permitted',
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('create goes ahead with the action', async () => {
    mocks.allowed.mockReturnValue(true);
    mocks.create.mockResolvedValue({
      id: PRODUCT,
      programmeId: PROGRAMME,
      name: 'X',
      description: null,
      sku: null,
      status: 'active',
      taxProfileId: null,
      version: 1,
      variants: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    expect(
      await outcome(() => createProductFor(tx, { programmeId: PROGRAMME }, { name: 'X' })),
    ).toBe('ok');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
