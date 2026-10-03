import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * A Playwright reporter owned by the acceptance suite, not by the e2e suite.
 *
 * An acceptance test that only checks `pnpm test:e2e` exited 0 cannot tell a
 * test that PASSED from one that was skipped, `fixme`d, or never matched the
 * grep at all — all three exit 0. So the acceptance suite passes this file as
 * an extra `--reporter` and reads what it writes: one row per test, with its
 * full title path and its final status.
 *
 * It imports nothing from `@playwright/test` on purpose. The acceptance
 * package does not depend on Playwright, and the handful of fields read here
 * are typed structurally below.
 */

export const OUTCOMES_FILE = resolve(__dirname, '..', '..', 'e2e', '.artifacts', 'acceptance-outcomes.json');

interface ReportedTest {
  titlePath(): string[];
  tags?: readonly string[];
  expectedStatus: string;
}

interface ReportedResult {
  status: string;
}

export interface E2eOutcome {
  title: string;
  tags: string[];
  status: string;
  expectedStatus: string;
}

export default class E2eOutcomesReporter {
  private readonly outcomes = new Map<string, E2eOutcome>();

  onTestEnd(test: ReportedTest, result: ReportedResult): void {
    const title = test.titlePath().filter((part) => part.length > 0).join(' › ');
    const tags = new Set<string>(test.tags ?? []);
    for (const match of title.matchAll(/@[\w-]+/g)) {
      tags.add(match[0]);
    }
    // Keyed on the title so a retry overwrites rather than duplicates.
    this.outcomes.set(title, {
      title,
      tags: [...tags],
      status: result.status,
      expectedStatus: test.expectedStatus,
    });
  }

  onEnd(): void {
    mkdirSync(dirname(OUTCOMES_FILE), { recursive: true });
    writeFileSync(OUTCOMES_FILE, `${JSON.stringify([...this.outcomes.values()], null, 2)}\n`, 'utf8');
  }

  printsToStdio(): boolean {
    return false;
  }
}
