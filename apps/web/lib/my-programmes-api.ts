import { z } from 'zod';
import { requestRecords, type RecordsResult } from './records-request';

/**
 * The caller's own programmes with their names (T-0043), apart from the
 * accounts client (T-0145): the programme line on every CRM list, the
 * pipeline chooser and the search scope all need this one read, and none of
 * the accounts calls, so a screen without accounts does not ship them.
 */
export const MY_PROGRAMMES_PATH = '/api/v1/me/programmes';

export const MyProgramme = z.object({ id: z.string(), name: z.string() });
export type MyProgramme = z.infer<typeof MyProgramme>;

const MyProgrammes = z.object({ data: z.array(MyProgramme) });

/** The session decides the list. */
export async function listMyProgrammes(): Promise<RecordsResult<readonly MyProgramme[]>> {
  const result = await requestRecords(MY_PROGRAMMES_PATH, MyProgrammes);
  return result.ok ? { ok: true, value: result.value.data } : result;
}
