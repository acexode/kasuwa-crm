# T-0193 follow-up: conversation-search preview redaction

## Changed
- `packages/domain/core/src/inbox/message-body-redact.ts`: added `redactMessageBodyForPreview` (emails to `[email]`; any 7+ digit run, optionally grouped by single space/dash/dot, to `***`; ISO dates left alone) and `previewOf(text, max)` which redacts the FULL text, then cuts. `redactMessageBodyForStorage` is unchanged.
- `search.repository.ts` `searchConversationsByPrefix`: preview is `previewOf(subject ?? body_redacted, 120)` (was cut-then-redact in the service).
- `apps/api/src/search/search.service.ts`: the second redaction pass is removed; the repository returns the final preview.
- Tests: spaced/dashed/dotted phones, grouped PAN, emails, short numbers, dates, straddling-cut. `conversation_search` flag stays default off.

## Known limits
Heuristic: 7+ digits in an order-number-like string with spaces is masked (over-redaction is the safe side). Names and free-text PII are not covered.

## T-0157 finding
A 42501 on the auth pool surfaced as a generic 500: `unexpected-error.filter.ts` only maps `isPoolConnectionTimeout` (packages/db/src/pool.ts:67) to 503. Fixed narrowly in `AuthService.signIn` phase one (`auth.service.ts`): 42501 -> `signInUnavailable()` (503). Other routes' 42501 remain 500 by design (a global mapping would hide grant bugs as load).
