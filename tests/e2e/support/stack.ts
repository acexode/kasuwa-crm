import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where the running stack is.
 *
 * `scripts/run-e2e.mjs` starts Postgres (Testcontainers), the API, the web app
 * and the static fixture server on free ports, then writes their URLs here.
 * Specs read the file rather than the environment: `process.env` is reserved
 * for `@kasuwa/config` (lint-enforced), and a file is also the thing that makes
 * a half-started stack fail loudly instead of quietly hitting localhost:3000 —
 * which, on a developer's machine, is very often somebody else's app.
 */

export interface StackUrls {
  /**
   * apps/web, a production build served by `next start` (T-0010), every
   * feature flag at its default. The only web server whose bytes are measured.
   */
  webUrl: string;
  /**
   * A second apps/web process with `self_serve_signup` switched ON in its
   * environment (T-0007). Server-side by construction: the flag is per
   * process, and nothing a browser sends can change it.
   *
   * It is `next dev`, not a production build: the flag is not production-ready
   * and a production process that names it refuses to boot until T-0016. Never
   * measure bytes against it — a dev bundle is not a budget.
   */
  webSelfServeUrl: string;
  /**
   * The same process as `webSelfServeUrl`, which also has `admin_live_api` ON
   * (T-0035): the P02 console against the real API and the seeded database.
   * `next dev` for the same reason — the flag is not production-ready until
   * T-0032 — so never measure bytes here either.
   */
  webLiveUrl: string;
  /**
   * A third apps/web process with `crm_records` ON (T-0042): the SAME
   * production build as `webUrl`, served by `next start` with NODE_ENV=test
   * because the flag is not production-ready (D-L64). The `/contacts` byte
   * budget is measured here.
   */
  webRecordsUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_accounts` ON
   * (T-0057): the P04 Accounts list. The `/accounts` byte budget is measured
   * here. The second name says which flag a spec relies on.
   */
  webAccountsUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_record_view` ON
   * (T-0062, D-L85): the P05 contact record at `/contacts/[id]`, on the same
   * production build, where its byte budget is measured.
   */
  webRecordViewUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_leads` ON
   * (T-0058): the P04 Leads list and its Kanban. The `/leads` byte budget is
   * measured here. The third name says which flag a spec relies on.
   */
  webLeadsUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_activities` ON
   * (T-0083): the P07 activities screen. The `/activities` byte budget is
   * measured here, and its summaries link to records this process serves.
   */
  webActivitiesUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_scripts` ON
   * (T-0115, T-0116): the P10 builder at `/scripts`, the agent's run at
   * `/script-runs/[runId]` and the start control on the contact record. The
   * builder's and the run screen's byte budgets are measured here.
   */
  webScriptsUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_pipeline` ON
   * (T-0109): the P06 pipeline board at `/pipelines/[pipelineId]` and its
   * index at `/pipelines`. The board's byte budget is measured here, and its
   * cards' summaries link to records this process serves.
   */
  webPipelineUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_search` ON
   * (T-0087): the P27 search screen at `/search` and the Ctrl/Cmd+K palette
   * in the CRM shell. The `/search` byte budget is measured here, and its hits
   * and "see all" links land on screens this process serves.
   */
  webSearchUrl: string;
  /**
   * A fourth apps/web process for the browser session (T-0125, ADR-0019): the
   * same production build under `next start` with NODE_ENV=test (because
   * `crm_records` is not production-ready, D-L64), `KASUWA_AUTH_MODE=jwt`, and
   * `crm_records` ON. Its specs inject no identity header: every identity
   * comes from the session cookie. EMPTY unless the run's grep can select
   * `@bff-session` (or there is no grep), to spare a gigabyte of memory.
   */
  webSessionUrl: string;
  /**
   * The same process as `webRecordsUrl`, which also has `crm_import` ON
   * (T-0096): the P28 import wizard at `/contacts/import`, the Contacts list
   * that links it and the list its report links back to. The wizard's byte
   * budget is measured here.
   */
  webImportUrl: string;
  /** apps/api, pointed at the Testcontainers database. */
  apiUrl: string;
  /** Static fixture pages used by the harness self-tests. */
  fixturesUrl: string;
}

/**
 * One file per Playwright project, not one shared `stack.json`.
 *
 * Two `pnpm test:e2e` invocations in the same checkout both wrote the shared
 * name, and the `over-budget` run writes empty urls — so a concurrent normal
 * run failed every remaining test with `navigating to ""`, which looks exactly
 * like a broken route and is not. It cost the T-0007 builder three runs, and
 * then turned the blocking isolation gate red, because the harness acceptance
 * suite runs `test:e2e` twice by design.
 *
 * Keyed on the project name rather than a process id or an environment
 * variable: the runner already knows it, `test.info()` already carries it, and
 * `process.env` is reserved for `@kasuwa/config` — see the note above, which
 * was right and which a first attempt at this fix ignored.
 */
function stackFileFor(project: string): string {
  return resolve(__dirname, '..', '.artifacts', `stack.${project}.json`);
}

let cached: (StackUrls & { project: string }) | undefined;

export function stack(): StackUrls {
  const project = test.info().project.name;
  const file = stackFileFor(project);

  if (cached?.project !== project) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new Error(
        `No running stack described at ${file}. Run the suite with "pnpm test:e2e", ` +
          'which starts Postgres, the API, the web app and the fixture server first.',
      );
    }
    cached = { project, ...(JSON.parse(raw) as StackUrls) };
  }
  return cached;
}
