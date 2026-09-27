import { expect, test } from '@playwright/test';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
} from '@kasuwa/db';
import { stack } from './support/stack';

/**
 * Tenancy, asserted through the layer a user actually touches.
 *
 * The API acceptance suite already proves this property. It is proved again
 * here because a browser is where it gets broken in practice: a client router
 * that fetches a record by id before the server has checked scope leaks a row
 * the API would have refused, and no server-side test sees it.
 *
 * Three URLs are tampered with, in increasing order of how plausible the
 * mistake is:
 *
 *   1. another TENANT_B tenant's contact          — the obvious attack
 *   2. another programme inside the SAME tenant   — the one people forget,
 *                                                   because "it's our data"
 *   3. a well-formed id that does not exist       — so we can tell the two
 *                                                   apart in the response
 *
 * All three must be 404 and all three must look identical. A 403 on the first
 * would confirm that the record exists, which is itself information about
 * another tenant's data (CLAUDE.md section 6.4).
 *
 * NOTE for whoever lands T-0007: this drives the API origin directly, because
 * apps/web has no record route yet. When one exists, add the same three cases
 * against the web URL — the browser-side check is the point, and this is
 * currently only half of it.
 */

function contactIn(programmeId: string): string {
  const contact = SEED_CONTACTS.find((candidate) => candidate.programmeId === programmeId);
  if (contact === undefined) {
    throw new Error(`no seeded contact in programme ${programmeId}`);
  }
  return contact.id;
}

const NO_SUCH_CONTACT = '00000000-0000-4000-8000-00000000dead';

test.describe('tenancy through the browser', () => {
  test('a signed-in user cannot reach another tenant by editing the URL @harness', async ({
    browser,
  }) => {
    const { apiUrl } = stack();

    // Tunde: Tenant A, programme A1 only. Nothing in this context tells the
    // server what he may see; the database resolves that from user_programme.
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-tenant-id': TENANT_A,
        'x-kasuwa-user-id': USER_A_AGENT_1,
      },
    });
    const page = await context.newPage();

    const own = await page.goto(`${apiUrl}/api/v1/contacts/${contactIn(PROGRAMME_A1)}`);
    expect(own?.status(), 'the caller cannot see their own record — the test proves nothing').toBe(
      200,
    );

    const bodies: string[] = [];
    for (const id of [contactIn(PROGRAMME_B1), contactIn(PROGRAMME_A2), NO_SUCH_CONTACT]) {
      const response = await page.goto(`${apiUrl}/api/v1/contacts/${id}`);
      expect(response?.status(), `GET /contacts/${id} leaked a record outside scope`).toBe(404);
      bodies.push(await page.evaluate(() => document.body.innerText));
    }

    const [otherTenant, otherProgramme, missing] = bodies;

    // A record in TENANT_B must be indistinguishable from one that was never
    // created. If these ever differ, the API has started confirming the
    // existence of another tenant's data.
    expect(otherTenant, 'the response distinguishes another tenant from a missing record').toBe(
      missing,
    );
    expect(otherProgramme, 'the response distinguishes another programme from a missing record').toBe(
      missing,
    );

    // And nothing of TENANT_B's may appear in the body, not even its id.
    expect(otherTenant).not.toContain(TENANT_B);
    expect(otherTenant).not.toContain(contactIn(PROGRAMME_B1));

    await context.close();
  });
});
