import { z } from 'zod';

/**
 * The record screens' read of the custom-field DEFINITIONS (`listCustomFields`,
 * `docs/api/admin.openapi.yaml`, T-0091). Same-origin, relative path, Zod-parsed.
 *
 * ACTIVE FIELDS ONLY. A record screen never shows a retired field, so this call
 * never asks for one (the studio, T-0090, is the only reader of those) and a
 * retired item that arrives anyway is dropped. NO SCOPE: a definition is
 * tenant-wide, and nothing here names a programme or a header that does.
 *
 * A failed read is `null`, never a partial list: the screens then draw no
 * custom value at all, because a value without its definition has no type, no
 * label and no currency (C9).
 */

export const CUSTOM_FIELDS_PATH = '/api/v1/admin/custom-fields';

export type CustomObject = 'contact' | 'account' | 'activity' | 'deal';

const FieldType = z.enum(['text', 'number', 'currency', 'date', 'picklist', 'boolean']);

const Definition = z.object({
  apiName: z.string(),
  label: z.string(),
  type: FieldType,
  config: z.object({
    values: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    currencyCode: z.enum(['NGN', 'GHS', 'KES', 'ZAR']).optional(),
  }),
  retiredAt: z.string().nullable().optional(),
});

const Answer = z.object({ items: z.array(Definition) });

export type CustomType = z.infer<typeof FieldType>;

/** One active definition, as a screen needs it. */
export interface CustomField {
  readonly apiName: string;
  readonly label: string;
  readonly type: CustomType;
  readonly values: readonly { readonly value: string; readonly label: string }[];
  readonly currency: string | null;
}

export async function listActiveCustomFields(object: CustomObject, signal?: AbortSignal): Promise<readonly CustomField[] | null> {
  const query = new URLSearchParams({ object });
  try {
    const response = await fetch(`${CUSTOM_FIELDS_PATH}?${query.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    const parsed = Answer.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;
    return parsed.data.items
      .filter((item) => item.retiredAt === null || item.retiredAt === undefined)
      .map((item) => ({
        apiName: item.apiName,
        label: item.label,
        type: item.type,
        values: item.config.values ?? [],
        currency: item.config.currencyCode ?? null,
      }));
  } catch {
    return null;
  }
}
