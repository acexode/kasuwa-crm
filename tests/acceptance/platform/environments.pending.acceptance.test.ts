import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0005 scope 2, environment baseline (Agent 13, DevOps).
 *
 * PENDING. `pnpm test:pending` runs it. T-0005 was assigned in rounds: CI
 * hardening and the observability skeleton first, environments later. This
 * assertion moved here, unchanged, from
 * `observability-pii.pending.acceptance.test.ts` when that suite was promoted,
 * so that promoting the round-one work did not also make the blocking gate
 * demand round-two work. Rename it to drop `.pending` when scope 2 is assigned.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

describe('acceptance (pending): nothing was provisioned', () => {
  it('writes Terraform but applies none of it', () => {
    // D-A4 is unanswered. The task is to produce a plan and a cost estimate so
    // it can be answered with numbers rather than a guess — not to spend money
    // while waiting for permission to spend money.
    const stateFiles = ['infra/terraform.tfstate', 'infra/terraform.tfstate.backup'];
    for (const file of stateFiles) {
      expect(existsSync(fromRoot(file)), `${file} exists — something was applied`).toBe(false);
    }

    const estimate = fromRoot('infra/COST-ESTIMATE.md');
    expect(existsSync(estimate), 'no cost estimate for D-A4 to be answered with').toBe(true);
  });
});
