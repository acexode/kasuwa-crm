# M1. Platform & tenancy

> **Owner:** Agent 1 — Platform & Security
> **Source:** Founding pack Part 2, section 2.7 — reproduced verbatim below.
> **Priority key:** P0 = MVP (must), P1 = v1 (should), P2 = v2 (could).

## Requirements

- P0: Multi-tenant org model. Org contains Business Units, which contain Client Programmes (BPO) and Teams. Programme-level data partitioning is enforced at the database (RLS) and API layers.
- P0: Tenant provisioning, custom subdomain, region selection (ZA primary, NG local cell), trial and plan limits.
- P0: White-label: logo, colours, custom domain, email sender domain, portal branding.
- P1: Sandboxes (config copy, masked data), config deployment between environments.
- P2: Reseller/partner tenancy (partners manage sub-tenants and billing).

## Cross-cutting requirements that apply here

- PRD 2.11 (tiered isolation: Pooled / Bridge / Silo; noisy-neighbour controls; white-label)
- PRD 2.13 (availability 99.9% Pooled / 99.95% Silo; data residency per tenant)
- Founding pack 3.3 (tenancy model, cells) and 3.12 (regions)

## User stories (PRD 2.8)

None directly, but every other module's isolation behaviour is this module's acceptance criterion.

## Open questions

*Written by the lead while splitting the PRD. These are things a builder cannot
determine from the source documents. **Do not guess — escalate.** Items marked
**blocked** have an entry in `team/DECISIONS.md`.*

1. **Partially built.** The scaffold implements the hierarchy, RLS and the vertical slice. Tenant provisioning, subdomains, region selection, plan limits and white-label are not started.
2. Custom subdomain plus automatic TLS — which layer terminates it, and how does a tenant map to a cell at the edge? Needs the control-plane design (founding pack 3.3, "global control plane"), which does not exist.
3. Sandboxes with masked data: masking rules are a compliance question (NDPA), not just an engineering one. Needs counsel input before design.
4. **D-T5** (is the telephony platform multi-tenant?) may force Silo tenants earlier than the PRD assumes — see ADR-0003.

---

*This file is a split of founding pack Part 2 section 2.7, edited per Addendum
A1. The requirement bullets are verbatim; everything else is the lead's
annotation. If they disagree, the founding pack and addendum win — and tell the
lead, because the annotation is wrong.*
