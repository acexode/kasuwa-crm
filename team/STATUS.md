# STATUS

*One screen. Everything else is for agents.*

**2026-10-04, evening.** `main` is verified, and every merge is checked locally with Docker (CI minutes are exhausted).

## Phase 1: done
| Task | What |
|---|---|
| T-0038 | Replacing an MFA factor invalidates the old backup codes |
| T-0006 | CI fails on an icon missing from the font |
| T-0011 | Redundant indexes dropped; `updated_at` maintained |
| T-0014 | Per-process config. Web can't see DB or storage secrets |
| T-0044 | Migration runner can build indexes concurrently |
| D-L59 | Timing-test flake fixed (cross-suite lockout state) |
| D-L62 | SWC wasm fallback, so browser tests run locally (T-0035's coverage passes) |

## Phase 2 (Contacts): first slice
| Task | State |
|---|---|
| T-0039 records contract | ✅ merged |
| T-0040 contact fields + accounts | ✅ merged |
| T-0041 contacts API (#83) | ✅ verified; **waiting on 2 suite edits (you)** |
| T-0042 Contacts screen (#81) | ✅ verified; **waiting on 1 budget edit (you)** |
| T-0043 display names | suite written; starts after T-0041 |
| T-0045 auth retention + 503 | building |

## Waiting on you
**Three test-file edits** that auto mode blocks. Switch auto mode off briefly and tell the lead; it makes them and you approve:
1. `tests/e2e/p04-contacts.spec.ts`: change the budget from `240_000` to `226_000`. This tightens it (T-0042).
2. `adversarial` suite: the FINDING-4 tripwire should assert "id is always `newId()`" (T-0041).
3. `observability-pii` suite: change the probe NIN, which collides with tenant A's id (T-0041).

**Decisions** (none block work; each has a lead recommendation):
- **D-P12:** dedupe and merge.
- **D-P13:** total counts on lists.
- **D-P14:** may agents edit contacts?
- **D-P15:** en-XA in production.
- **Dotgo:** sales answers on SMS fallback, rates and data location.

## Risks the lead is carrying
- D-L55, D-L56 and D-L68 follow-ups. Notable: `displayName` undercuts withheld name parts, and search has no index yet.
- No production cell exists yet. D-L65 sets the migration rule for when one does.
- No branch protection until the org move (D-L34).
