# T-0169 — Payment links

| Field | Value |
|---|---|
| **id** | T-0169 |
| **status** | `assigned` |
| **module** | M05 — Products, quotes, CPQ, invoicing & payments |
| **owner** | Cursor — Phase 3 |
| **priority** | P0 |
| **decisions** | D-A3. Paid and expired only. Refunds, partials and reconciliation stay out (B3). |
| **budget** | Max 3 sessions before escalating |

## Goal

Create a payment link for a sent or accepted quote and apply a signed webhook
that marks the quote `paid` or the link `expired`. `paid` is not a client
status. Unknown slug, bad signature, unknown link and a cross-tenant signature
share one 401 body. No card number is stored or returned.
