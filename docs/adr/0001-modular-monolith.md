# ADR-0001 — Modular monolith, not microservices

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** Lead agent, @acexode
- **Source:** Founding pack 3.1

## Context

Kasuwa spans 23 PRD modules — CRM records, pipeline, quoting, messaging,
ticketing, workflow, metadata, reporting, AI and billing — built by thirteen
parallel agent sessions. The obvious reflex at that module count is
microservices.

CRM domains are unusually relational: permissions, workflows and the metadata
engine touch every record type. A service boundary drawn between them produces
distributed transactions and duplicated permission checks at exactly the points
where correctness matters most.

## Decision

A TypeScript modular monolith with a small number of separately deployed runtime
processes: `apps/api`, `apps/worker`, `apps/realtime` (and an AI gateway later).
Module boundaries are enforced in code, not by the network.

`packages/domain/*` may depend on `scope:shared` (db, permissions,
metadata-engine, config, i18n) and `scope:adapter`, and never on another
domain's internals. The rule is enforced by `@nx/enforce-module-boundaries`, and
`pnpm lint:boundaries:verify` proves the rule actually fires rather than sitting
inert in a config file.

Realtime and worker are separate processes from day one because they are
genuinely different workloads, not because the domains are separate.

## Consequences

**Good.** One repository, one language, end-to-end types — which is what makes
agent sessions effective, since an agent can see a change's full blast radius.
No distributed transactions. Permission logic lives in one place. Modules can be
extracted later along boundaries that are already enforced.

**Bad.** One deployable means one blast radius: a bad merge can take everything
down, so CI and feature flags carry more weight than they would with services.
Scaling is coarse-grained. The boundary rule is the only thing preventing a
tangle, so weakening it — adding an `allow` exception, tagging a domain package
as shared — is a significant act and should be an ADR of its own.

**Watch for.** The temptation to add a cross-domain import "just this once". The
rule is enforced; route around it through an interface or an event instead.
