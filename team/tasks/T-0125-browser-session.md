# T-0125 — The web app keeps a session after sign-in (ADR first)

**status** `not-assigned` (ADR to be written; suite to be written) · **owner** Agent 1 · **priority** P0 · **decisions**
D-L147, ADR-0007, ADR-0010, D-L05, CLAUDE.md section 6

## Goal
Sign-in and MFA work, but the web app stores the resulting session token nowhere: no cookie and no BFF. So in a real
browser every `/api/v1` call carries no identity, and every CRM screen is empty or "not authenticated". The e2e suites
hide this because they inject stub identity headers through Playwright. The demo works only through
`tools/demo-proxy.mjs`, a loopback-only stand-in (#142).
- **An ADR first** (Agent 1 with the lead), choosing between:
  - a Next.js BFF that holds the access token in an HttpOnly, Secure, SameSite cookie and calls the API server-side;
  - the API setting its own cookie on its origin.

  It must settle:
  - CSRF protection for cookie-borne writes (bodyless POSTs included; the T-0090 review noted these);
  - token refresh and expiry;
  - sign-out and revocation;
  - the CSP;
  - the low-bandwidth cost;
  - how the stub mode and e2e header injection coexist without any production path accepting stub headers.
- **Then build it,** keeping the session as the only source of scope (CLAUDE.md 2.2).

## Acceptance tests
To be named by the lead's suite branch. It must include a real-browser journey that signs in and then loads a CRM screen
with no injected headers.

## Non-goals
SSO and SAML, and "remember this device" beyond what the ADR rules.
