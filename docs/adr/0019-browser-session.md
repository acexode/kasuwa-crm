# ADR-0019 — The browser session: a same-origin BFF holds the token in an HttpOnly cookie

- **Status:** Accepted by @acexode on 2026-10-19, with the five amendments at the end (D-L178). Proposed under T-0125 and D-L147.
- **Date:** 2026-10-18
- **Deciders:** Lead; Agent 1 drafted it; @acexode reviews
- **Amends:** ADR-0007 (where stub identity may travel), ADR-0008 (how the opaque token reaches a browser). Removes the
  `/api/v1` rewrite in `apps/web/next.config.mjs`.
- **Does not change:** the API's token transport, `app.resolve_session`, `auth_session`, the number of SECURITY DEFINER
  functions (still two), or any tenancy test.

## Context

Sign-in and MFA work end to end. `POST /api/v1/auth/mfa` (and `/auth/mfa/enrol/confirm`) answers with an opaque
`ksw_s1_…` token (ADR-0008), and the web app throws it away: `mfa-screen.tsx` calls `router.push('/')` and nothing stores
the token. Every later `/api/v1` call from a real browser carries no identity, and in `jwt` mode the API answers 401.

Three things hid this:

- **The e2e suites inject stub identity.** Playwright's `extraHTTPHeaders` adds `x-kasuwa-tenant-id` and `x-kasuwa-user-id`
  to every request. The default e2e web server runs `NODE_ENV=production`, `KASUWA_AUTH_MODE=jwt`, and the Next rewrite
  passes those headers through to an API that runs `stub` under `NODE_ENV=test`. So the browser-side journeys prove the
  screens, never the session.
- **The demo runs through `tools/demo-proxy.mjs`** (#142), a loopback-only `node:http` front door. It captures the token
  from the MFA response into an HttpOnly cookie and re-sends it as `Authorization: Bearer`. It is, in miniature, the
  missing layer.
- **No screen has a sign-out.** Nothing exercised the end of a session.

What is already true, and constrains the design:

- **The API is same-origin to the browser.** `next.config.mjs` rewrites `/api/v1/:path*` to `NEXT_PUBLIC_API_URL`, so
  every web transport (`auth-api.ts`, `records-api.ts`, `admin-api.ts`, `pipelines-api.ts`, `scripting-http.ts`,
  `custom-fields-api.ts`, `contact-record-api.ts`, `search-api.ts`) fetches a relative path. The browser already makes
  two legs per call: browser to the Next server, Next server to the API. The API has no CORS configuration.
- **The API has exactly one token transport.** `readBearerToken` accepts `Authorization: Bearer` and nothing else (no
  query parameter, no cookie). `KasuwaAuthGuard` refuses scope headers in every mode, accepts stub identity headers only
  under `KASUWA_AUTH_MODE=stub` and refuses Bearer plus stub headers together. `@kasuwa/config` refuses `stub` under
  `NODE_ENV=production`, in the API and in `webEnv()`.
- **The web process holds no database URL.** `webEnv()` refuses `DATABASE_URL`, `DATABASE_AUTH_URL` and the migrator URL
  by presence.
- **Sessions are rows.** Twelve hours absolute (`KASUWA_AUTH_SESSION_HOURS`), no refresh, revoked by
  `auth_session.revoked_at`, re-resolved on every request. Scope is re-read from `user_programme` inside every tenant
  transaction. Session lifetime, refresh and concurrent sessions are product decisions (PRD M02 point 3; ADR-0008
  "Open") and nobody has made them.
- **The web app has no CSP today.** No header is set anywhere in `apps/web`.
- **Rendering is client-side for data.** No server component calls the API; pages read flags server-side and the
  screens fetch from the browser.
- **Bodyless POSTs exist** (archive, retire, publish-style actions). The T-0090 review noted that they need a CSRF
  control the moment the transport becomes a cookie (D-L145 "Noted").

## Decision

**A Next.js route handler at `/api/v1/*` is the browser's only door to the API. It keeps the session token in a
host-only HttpOnly cookie, never shows it to page JavaScript, enforces CSRF on every unsafe method, and forwards to the
API with `Authorization: Bearer` server-side. The API does not change.**

Authentication still says only WHO. The BFF never resolves a session, never reads a database and never decides scope. It
moves the token from a cookie into a header and nothing else. The API resolves the session through
`app.resolve_session`, and scope through `user_programme`, exactly as today. `tests/acceptance/tenancy/` is untouched by
this design, and needing to touch it would mean the design is wrong.

### 1. The BFF route

- One catch-all route handler, `apps/web/app/api/v1/[...path]/route.ts`, exporting GET, HEAD, POST, PUT, PATCH and DELETE,
  `dynamic = 'force-dynamic'`, Node runtime. It replaces the `rewrites()` entry, which is deleted.
- The upstream is a new **server-only, runtime** variable, `KASUWA_API_INTERNAL_URL`, read through `webEnv()`. It replaces
  `NEXT_PUBLIC_API_URL`: a `NEXT_PUBLIC_` name is inlined into client bundles, and the browser must never need the API's
  address. Because the rewrite was resolved at build time, this also stops a build being tied to one API origin.
- **Request headers are an allowlist, not a denylist.** Forwarded: `accept`, `accept-language`, `content-type`,
  `content-length`, `if-match`, `idempotency-key`, and the client address chain (point 9). Everything else is dropped,
  including any browser-supplied `authorization` and `cookie`. The browser path is cookie-only; a non-browser client
  calls the API directly with its own Bearer token, as today.
- **`x-kasuwa-*` from the browser:**
  - a scope header (`x-kasuwa-programme-ids`, `x-kasuwa-programme-id`, `x-kasuwa-scope`) is **refused by the BFF** with
    the API's own 400 body (`SCOPE_HEADER_REJECTED_BODY`). Loud, as ADR-0007 property 2 requires, and the existing e2e
    `expectViolation` checks keep their answer;
  - the two stub identity headers are forwarded **only** when the web process itself runs `KASUWA_AUTH_MODE=stub`
    (point 7), which `webEnv()` refuses under `NODE_ENV=production`;
  - every other `x-kasuwa-*` header (for example the e2e suites' `x-kasuwa-feature-flags` probe) is dropped silently.
  - The header names and the 400 body move out of `apps/api/src/tenancy/auth-context.ts` into a shared, browser-safe
    module so the API and the BFF cannot drift (location: open question 8).
- **Bodies stream** in both directions (`duplex: 'half'` on the request; the upstream body returned as the response body).
  The BFF buffers only the two token-bearing auth responses (point 3), which are small.
- **Every BFF response** gets `Cache-Control: no-store` (overwriting whatever upstream sent), `X-Content-Type-Options:
  nosniff`, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. The upstream `fetch` is called with
  `cache: 'no-store'`, so Next's data cache never holds an authenticated answer.
- **A top-level navigation to `/api/*` is refused** (`Sec-Fetch-Dest: document` or `Sec-Fetch-Mode: navigate`), as the
  generic 404. No screen navigates to the API, and this removes the only case in which a `Lax` cookie rides a cross-site
  request.
- Errors keep the API's shape and say nothing new. An unreachable API is a 502 with the generic `internal_error` body,
  never the upstream address or a stack.

### 2. The cookie

| Attribute | Value | Why |
|---|---|---|
| Name | `__Host-kasuwa_session` | The prefix makes the browser refuse it unless it is `Secure`, `Path=/` and has no `Domain`. A sibling subdomain can neither read it nor plant one (no session fixation from `*.kasuwa…`) |
| Value | the API's opaque token, verbatim | No second token, no encryption layer. The value is already a meaningless lookup key (ADR-0008); wrapping it adds a key to manage and protects nothing |
| `HttpOnly` | always | Page JavaScript, and therefore an XSS, cannot read it |
| `Secure` | always outside development and test (point 8) | |
| `SameSite` | `Lax` | See below |
| `Path` | `/` | Required by `__Host-` |
| `Domain` | never set | Host-only |
| `Max-Age` | seconds until the API's `expiresAt`, never longer | The cookie dies with the session, not after it |

**Why `Lax` and not `Strict`.** CSRF is not carried by SameSite here; point 4 is the control and SameSite is a second
layer. `Strict` would withhold the cookie on the top-level arrival from an email, WhatsApp or ticket link, so any
server-side check on page load (a signed-out redirect, a future server-rendered screen) would bounce a signed-in user to
sign-in. `Lax`'s one residual, the cookie on a cross-site top-level GET, is closed by point 1's navigation refusal and by
GET being safe. If @acexode prefers `Strict`, nothing else in this ADR changes (open question 2).

**Not scoped to `Path=/api`.** It would save the cookie's ~75 bytes on page and asset requests, but `__Host-` requires
`Path=/`, and `Path` is not a security boundary while host-locking is. Over HTTP/2 the repeated header compresses to a
byte or two after the first request (point 6).

### 3. Sign-in: capturing the token

- `POST /api/v1/auth/mfa` and `POST /api/v1/auth/mfa/enrol/confirm` are the only routes that issue a token. On a 200 from
  either, the BFF parses the body with Zod, sets the cookie from `accessToken` and `expiresAt`, and returns the body
  **with `accessToken` and `tokenType` removed**. Backup codes, `expiresAt` and `user` pass through. The browser never
  holds the token, even for one render. A body that does not parse is a 502, never passed through.
- If a session cookie was already present, the BFF revokes that session (a best-effort `sign-out` call with the old
  Bearer) before setting the new one. One browser profile holds one session; signing in as someone else, or into another
  tenant, ends the previous session rather than orphaning a live one.
- The browser-facing auth response therefore differs from `docs/api/auth.openapi.yaml`. The web app's `SessionEstablished`
  schema becomes `{ expiresAt, user }`, and the BFF's variance is documented next to the contract.
- Every other `/auth/*` route (sign-in, challenge re-issue, enrol, SSO lookup) is forwarded as is, cookie or not.

### 4. CSRF

Every request whose method is not GET, HEAD or OPTIONS must pass **all three** checks, whether or not a session cookie is
present. Unauthenticated routes are included, because sign-in and MFA are login-CSRF targets (an attacker signing the
victim into the attacker's tenant).

1. **Origin.** `Origin` must equal `KASUWA_WEB_ORIGIN` exactly. A missing `Origin` is refused; current browsers send it
   on every POST, PUT, PATCH and DELETE, same-origin included. The comparison is with configuration, never with `Host` or
   `X-Forwarded-Host`, which a client or a misconfigured proxy can set. `Sec-Fetch-Site`, when present, must be
   `same-origin`.
2. **A custom request header**, `x-requested-with: kasuwa-web`, sent by the web app's single fetch wrapper. A cross-origin
   page can only add a custom header after a CORS preflight, and nothing at this origin answers one. This is the control
   that closes **bodyless POSTs**: a form or a `no-cors` fetch can send a bodyless POST with no preflight, but cannot add
   this header. (Deliberately not `x-kasuwa-*`, which point 1 strips.)
3. **Content type.** A request with a body must be `application/json`. `text/plain`, `application/x-www-form-urlencoded`
   and `multipart/form-data` are refused; they are the three a cross-site form can send. File bytes never come here
   (ADR-0017: browser to bucket on presigned URLs).

A refusal is a 403 with a fixed body and code (`csrf_rejected`) that names no check, logged without headers or body.

**Not a double-submit token.** With the Origin check and the custom header both mandatory, a double-submit token adds a
JavaScript-readable cookie and a value to rotate, and blocks nothing the other two do not. It is the fallback if a
supported browser is ever found that omits `Origin` on unsafe requests (open question 3 asks whether any target device
does).

### 5. Lifetime, scope changes, sign-out and revocation

- **Lifetime is the API's.** Twelve hours absolute today, configurable through `KASUWA_AUTH_SESSION_HOURS`. The cookie's
  `Max-Age` follows `expiresAt`. **No refresh, no sliding window, no rotation** in this ADR. Those are the open product
  decision (open question 1). If one is made, the mechanism is: the API issues a successor token on a new endpoint and
  revokes the old one, and the BFF swaps the cookie. The cookie design does not change.
- **Scope changes mid-session take effect on the next request, unchanged.** The BFF caches nothing about the caller.
  Removing a user from a programme, disabling them or suspending their tenant works exactly as ADR-0008 describes,
  because the API re-reads `user_programme`, `"user"` and `tenant` per request.
- **Sign-out.** `POST /api/v1/auth/sign-out` (CSRF-checked like any write). The BFF forwards it with the Bearer token so
  the API revokes the row, then clears the cookie (`Max-Age=0`) **whatever the API answered**, and adds
  `Clear-Site-Data: "cache"`. The web app gets a sign-out control in the CRM and admin shells (it has none today).
- **Server-side revocation needs nothing new.** A revoked, expired or disabled session gets the API's 401
  `not_authenticated`. On any such 401 the BFF also clears the cookie, so a dead session does not keep riding every
  request, and the web transports send the user to sign-in. The BFF never decides that a session is valid. Only the API
  does.
- Out of scope, recorded so they are not mistaken for oversights: "sign out everywhere", revoking other sessions on a
  factor or password change, and "remember this device" (open question 5).

### 6. Low-bandwidth cost

- **No extra network leg.** Today's rewrite already proxies through the Next server; the BFF replaces it hop for hop.
  The browser's side of a request is unchanged on a 2G link. The added cost is server-side: a route handler invocation
  and header filtering, in-cell, measured in single milliseconds.
- **Bytes per request:** the cookie, ~75 bytes, sent on every same-origin request. HTTP/2 header compression makes it a
  byte or two after the first. The CSRF header is ~30 bytes on writes only. The response loses `accessToken`.
- **Compression must survive the hop.** Node's `fetch` decompresses upstream bodies. The BFF must pass upstream encoding
  through, or Next must recompress, so JSON reaches the browser compressed. A test pins that a list response arrives with
  `Content-Encoding`. On a 2G link this matters more than every other line in this section.
- **Caching:** always `no-store` (point 1). Nothing authenticated is cacheable by the browser, a proxy or Next, which
  matches `records-api.ts`'s existing second layer. Static assets are unaffected.
- The upstream agent keeps connections alive to the API, so the in-cell leg pays no TCP or TLS setup per request.

### 7. Stub mode and e2e header injection

**No production path may accept stub identity.** That stays true by three independent locks:

1. **The API** keeps its guard unchanged: stub headers only under `KASUWA_AUTH_MODE=stub`, refused with a Bearer token,
   scope headers refused always; and `@kasuwa/config` refuses `stub` under `NODE_ENV=production`.
2. **The BFF** forwards `x-kasuwa-tenant-id` and `x-kasuwa-user-id` only when the **web** process's own
   `KASUWA_AUTH_MODE` is `stub`, read once at boot through `webEnv()`, which already refuses `stub` under
   `NODE_ENV=production`. In `jwt` mode it drops them, and a unit test pins that.
3. **The BFF never adds stub headers of its own.** It has no identity table, no switcher and no demo route. The demo
   proxy's quick-switch is not carried over (point 11).

| Web process | API process | Browser sends stub headers | Result |
|---|---|---|---|
| production, `jwt` | production, `jwt` | dropped by the BFF | cookie session only |
| production, `jwt` | test, `stub` (e2e) | dropped by the BFF | cookie session only: the real-browser journey runs here |
| test or dev, `stub` | test or dev, `stub` | forwarded | stub identity, as today's e2e specs need |
| test or dev, `stub` | production, `jwt` | forwarded | the API answers 401; cannot happen in a deployment, and is harmless |

**What the e2e harness changes** (a lead edit to `tests/e2e/scripts/run-e2e.mjs`): the specs that inject identity run
against web processes started with `NODE_ENV=test` and `KASUWA_AUTH_MODE=stub`. That is the same production build under
`next start`, the pattern the `crm_records` process already uses (D-L64). The default `NODE_ENV=production`, `jwt` web
process runs the T-0125 real-browser journey with **no injected headers**, and a negative test that injected stub headers
are ignored there. Which process the byte budgets measure is the lead's call (open question 7).

### 8. Secure-by-default configuration (D-L94)

`webEnv()` gains a guard, `assertSessionCookieIsSafe`, beside `assertAuthModeIsSafe` in `packages/config/src/guards.mjs`,
run before the server binds a port:

- **The cookie's attributes are constants in code, not configuration.** HttpOnly, SameSite=Lax, Path=/, no Domain and the
  `__Host-` name cannot be set from the environment, so no deployment can weaken them by mistake.
- **One relaxation exists, and only for development and test:** `KASUWA_SESSION_COOKIE_INSECURE=1` drops `Secure` and the
  prefix (the name becomes `kasuwa_session`), for browsers that will not store a `Secure` cookie on `http://localhost`.
  **Outside `NODE_ENV=development` and `test` its presence, with any value, refuses boot.**
- **`KASUWA_WEB_ORIGIN` is required** (the CSRF Origin check needs it) and must be an origin: scheme, host and port, no
  path, no userinfo. Outside development and test it must be `https:`. The one exception is a loopback host, which
  browsers treat as a secure context, so the e2e production process can run on `http://127.0.0.1`. This is not "loopback
  means development" (D-L95): `Secure` and the prefix still apply there.
- `KASUWA_API_INTERNAL_URL` is required, and like every URL in `@kasuwa/config` it may carry no credentials. Whether it
  must be `https:` in production is open question 4.
- Unit tests in `packages/config/src/config.test.ts` assert each refusal, in the style of the existing auth-mode tests.

### 9. Multi-tenant scoping

- **Today one web host serves a cell**, and the tenant comes from the slug typed at sign-in. The token is bound to one
  tenant in `auth_session`, so the cookie needs no tenant in its name or value, and a tenant id in the cookie would be a
  claim somebody might trust (ADR-0008's reason for opaque tokens).
- **No cross-tenant reuse is possible.** The cookie is host-only, and a Silo tenant's cell has its own host and therefore
  its own cookie jar. In the pooled cell one profile holds one session (point 3), so a person who works for two tenants
  uses two browser profiles. Presenting tenant A's token can only ever act as tenant A, because the API takes the tenant
  from the session row.
- **If per-tenant subdomains arrive later,** `__Host-` already keeps each subdomain's cookie its own. The BFF must then
  also refuse a session whose tenant is not the host's tenant, with the same 401 as any other failure. That needs the API
  to *narrow* on an expected tenant (refuse on mismatch, never select by it) and gets its own ADR then.
- **Client address.** The sign-in throttle keys on the client address through `KASUWA_TRUST_PROXY_HOPS`. The BFF passes the
  `X-Forwarded-For` chain on exactly as the rewrite did today, so the API's hop count is unchanged. A test pins that two
  client addresses reach two throttle keys through the BFF.

### 10. The CSP

Set by `apps/web/middleware.ts` on every page response (its matcher widens to all page routes; the BFF sets its own, point
1). A per-request nonce:

```
default-src 'self';
script-src 'self' 'nonce-{n}' 'strict-dynamic';
style-src 'self' 'nonce-{n}';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'none';
object-src 'none';
upgrade-insecure-requests
```

- **`connect-src 'self'` is the change that matters.** The browser talks only to its own origin, so the API's address
  appears nowhere in the policy or the bundles. Additions come with the features that need them and no sooner: the
  object-storage host when imports ship (ADR-0017 point 4), and the realtime origin when realtime auth is designed (open
  question 6).
- **Development only:** `'unsafe-eval'` in `script-src` and the HMR websocket in `connect-src`, keyed on
  `NODE_ENV=development`. `upgrade-insecure-requests` is omitted on loopback.
- If React `style={}` props need it, `style-src-attr 'unsafe-inline'` is added, never `'unsafe-inline'` on `style-src`.
  The build task measures this rather than guessing.
- A nonce makes every page dynamically rendered. The pages already read flags on the server, so in practice they are
  dynamic now; the byte budgets are re-measured in the same PR.
- `Strict-Transport-Security` is set at the ingress, not by the app.

### 11. Migration from the demo proxy

Once the BFF is merged:

- **Delete** `tools/demo-proxy.mjs`.
- **Edit** `tools/demo.mjs` (no proxy process, no port 3100; the demo opens the web app on 3000), `tools/demo-smoke.mjs`
  (sign in for real through the web app with `tools/demo-totp.mjs` rather than `/__demo/as/<role>`), and
  `docs/demo/DEMO.md` (port 3100, the switcher and the "why 3100" section go; the troubleshooting rows change).
- **The quick-switch goes with it.** Recreating it inside the BFF would put a stub-identity path in the production
  artefact. Presenters sign in for real, which is also the honest demo (open question 3 confirms the cost).
- Update `apps/web/CLAUDE.md` (the BFF is the API door; no `NEXT_PUBLIC_API_URL`), and the ADR-0007 header to note that
  stub identity now crosses the web tier only in stub mode.

### 12. Build plan

Agent 1 owns T-0125. Every file here is on the D-A3 list. Suggested split, each PR within the ~600-line rule:

| Step | Owner | Files | Proves |
|---|---|---|---|
| **a. Config** | Agent 1 | `packages/config/src/schemas.mjs`, `guards.mjs`, `web.mjs`, `config.test.ts`; `.env.example` | point 8's refusals; `KASUWA_WEB_ORIGIN`, `KASUWA_API_INTERNAL_URL`, `KASUWA_SESSION_COOKIE_INSECURE` |
| **b. Shared header policy** | Agent 1 | a shared module for the stub and scope header names and the 400 body (open question 8); `apps/api/src/tenancy/auth-context.ts` imports it | API behaviour unchanged; its existing tests pass |
| **c. The BFF** | Agent 1 | `apps/web/app/api/v1/[...path]/route.ts`; `apps/web/lib/server/bff-forward.ts`, `session-cookie.ts`, `csrf.ts`, `header-policy.ts` with unit tests; remove `rewrites()` from `apps/web/next.config.mjs`; extend `apps/web/app/client-boundary.test.ts` so no client module imports `lib/server/` | points 1 to 5 and 9, by unit test |
| **d. Web transports** | Agent 11, Agent 1 reviews | one `apps/web/lib/api-fetch.ts` used by all eight `*-api.ts` transports (sends `x-requested-with`, maps 401 to sign-in); `SessionEstablished` reshaped in `auth-api.ts`; a sign-out control in the CRM and admin shells; i18n keys; a lint rule against raw `fetch('/api…')` outside the wrapper | no screen can forget the CSRF header |
| **e. CSP** | Agent 1 | `apps/web/middleware.ts`, `apps/web/app/layout.tsx` (nonce) | point 10; byte budgets re-measured |
| **f. Suite and harness** | Lead / Agent 12 | `tests/e2e/scripts/run-e2e.mjs` (point 7's process split); a new real-browser journey; an integration suite against the route handler | see below |
| **g. Demo clean-up** | Agent 1 | point 11's files | `pnpm demo` works with no proxy |

The acceptance suite (lead-written, per T-0125) should at least cover:

- sign in, MFA by TOTP, load `/contacts` with **no injected headers**; the cookie is `HttpOnly`, `Secure`, `SameSite=Lax`,
  host-only; no response body or page script ever holds the token;
- injected stub headers on the production web process are ignored, and a scope header is refused with the API's 400;
- CSRF: a cross-origin POST, a missing `Origin`, a missing custom header, a **bodyless POST** without the header, and a
  `text/plain` body are each refused with no side effect;
- sign-out revokes server-side: replaying the old cookie value (set by hand) gets 401;
- disabling the user and removing them from a programme take effect on the next request, with no re-sign-in;
- a 401 clears the cookie; every BFF response is `no-store`; a list response arrives compressed;
- `webEnv()` refuses the insecure flag and a non-https origin under `NODE_ENV=production`;
- `tests/acceptance/tenancy/` passes **unmodified**.

## Consequences

**Good.**

- A real browser has a session, and the token never reaches page JavaScript, so an XSS can act as the user while the page
  is open but cannot carry the session away.
- **The API does not change.** It keeps one transport, gains no CSRF surface, no cookie parsing and no knowledge of the web
  origin. CSRF lives in one file, in front of every route, rather than as a property each new controller must remember.
- Mobile, integration and test clients keep calling the API with Bearer exactly as today.
- The browser's network cost is unchanged; the API address leaves the client bundle; the build is no longer tied to one
  API origin.
- The demo stops depending on a side tool.

**Bad.**

- **The web tier becomes security-critical.** Until now it held nothing; now it holds the session transport and the CSRF
  control. A bug in header filtering is an auth bug, and `apps/web/lib/server/` joins the D-A3 review list.
- The browser-facing auth responses diverge from `auth.openapi.yaml` (no `accessToken`). The divergence is deliberate and
  must be documented where the contract is.
- One session per browser profile.
- The e2e harness splits into a stub process and a production process, adding a web server to a run that already starts
  several. Memory on the 16 GB machine needs watching (CLAUDE.md section 3).
- Nonce-based CSP forces dynamic rendering and adds a middleware run to every page request.

**Honest.** The cookie only moves where the token lives. Anything that can run script in the page can still make
same-origin requests as the user while the tab is open. The CSP narrows that; nothing here removes it.

## Alternatives rejected

**The API sets the cookie on its own origin.** This is the serious alternative, and through today's rewrite it would even
land on the web origin, since the browser cannot tell the rewrite is there. It would need fewer moving parts in Next. It
is rejected because:

- the API gains a second token transport, plus precedence rules between cookie, Bearer and stub headers. The guard's
  "exactly one transport" property, which is why a token never appears in a URL or log, would be gone;
- **every API controller becomes CSRF-exposed**, bodyless POSTs included, in every module, now and for every route added
  later. The control would have to be global middleware in the API and kept correct as the API grows, instead of one
  file in the only place cookies exist;
- the API would need to know the web origin (Origin check, `Domain` decisions), coupling it to a deployment detail it does
  not have today;
- if the browser ever reaches the API on its own origin (for example a separate realtime or API host), the cookie needs
  `SameSite=None` and CORS with credentials, which reopens all of the above;
- the token would still come back in a JSON body for non-browser clients, so the web app would need to be careful never to
  read it anyway.

The extra hop the BFF seems to cost does not exist here, because the rewrite already pays it.

**Next middleware injects `Authorization` into the existing rewrite.** It is lighter, but middleware cannot see the
upstream response, so it cannot capture the token from the MFA body, strip it, clear the cookie on a 401 or force
`no-store`. That means route handlers for those cases anyway, and the security logic split across two mechanisms with
subtle header-override semantics. One route handler is easier to review and to test.

**Keep the token in page memory or `sessionStorage`, sent as Bearer by the transports.** Any XSS can exfiltrate it. The
memory version also loses the session on every reload, and `sessionStorage` survives in a way the user cannot see.
`localStorage` is worse on both counts. Rejected.

**Promote `tools/demo-proxy.mjs` to a production ingress.** It is the same idea in a separate process with no tests, a
hand-rolled cookie parser and a stub-identity switcher built in. It would be one more deployable for a job Next already
does.

**Encrypt or sign the cookie value (iron-session style).** The value is already an opaque random key, and only its hash is
stored. Wrapping it adds a secret to rotate and a dependency, and protects nothing that HttpOnly and the server-side row do
not. Rejected; no new dependency is needed for this design at all.

**A double-submit CSRF token instead of the custom header.** See point 4. It is kept as the fallback.

## Open questions for @acexode

1. **Session lifetime, idle timeout and refresh** (PRD M02 point 3; ADR-0008 "Open"). This ADR keeps twelve hours
   absolute, no refresh, and the cookie follows it. For agents on shift, is an idle timeout wanted, and how long? An idle
   timeout needs a per-request write (`last_seen_at`, throttled) on the auth pool and an amendment to ADR-0013's grants.
2. **`SameSite=Lax` or `Strict`?** The recommendation is Lax, for link arrivals; Strict changes nothing else in the design.
3. **Two confirmations on cost:** is losing the demo quick-switch acceptable; and does any device Kasuwa targets
   (feature-phone browsers, older Android WebViews, Opera Mini's server-side mode) omit `Origin` on POST? If so, a
   double-submit token is added for those, not instead of the Origin check.
4. **Must the web-to-API leg be TLS in production,** or is in-cell plaintext acceptable? The Bearer token travels on it.
   The recommendation is to require `https:` or a mesh with mTLS and to refuse `http:` outside loopback, as point 8 does
   for the browser origin.
5. **Out of scope unless you say otherwise:** sign out everywhere, revoking other sessions on a factor or password change,
   and "remember this device". The first two are cheap (`UPDATE auth_session` by user) and arguably belong with this.
6. **Realtime.** The cookie is host-only on the web origin, so the realtime process will not see it. Realtime auth (likely
   a short-lived ticket minted through the BFF) needs its own design and is not settled here.
7. **The e2e harness** (point 7) is a lead edit: confirm the stub and production process split, and which process the
   byte budgets measure.
8. **Where the shared header constants live.** `apps/web` cannot import `apps/api`. Candidates are a small export in
   `@kasuwa/config` or `@kasuwa/permissions`; either is a shared-scope package both may use (CLAUDE.md 2.5).

## Amendments on acceptance (2026-10-19, D-L178)
These settle points this ADR left open. They were ruled by the T-0125 suite (D-L172) and confirmed by @acexode.
1. **The browser journey's process.** The real-browser journey runs on a dedicated production-build web process
   (`webSessionUrl`), started only when `@bff-session` is selected, because the default production process cannot
   serve `/contacts`.
2. **Loopback.**
   - `Secure` and the `__Host-` prefix stay on for loopback http.
   - `KASUWA_API_INTERNAL_URL` must be https under production, except on a loopback host. This adds a loopback
     exception to D-L149 #4.
   - `127.0.0.1.evil.example` is not loopback.
3. **Required settings.** `KASUWA_WEB_ORIGIN` and `KASUWA_API_INTERNAL_URL` are required in every mode.
4. **Nonce and 404.** The CSP nonce is at least 128 bits and fresh per response. A browser navigation to `/api/*`
   gets the API's unknown-route 404.
5. **Two session cookies.** A request carrying two session cookies never mixes tenants and never answers 5xx.
