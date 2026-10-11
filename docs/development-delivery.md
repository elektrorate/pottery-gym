# Domain Integrity Delivery

Branch: `feat/domain-integrity-authorized-api`.
Starting commit: `0ee7a72`, which already integrates the four commits of PR #1.
Issues #2 through #7 and PR #1 were read before editing. Issues #8/#9 expose
additional business/security dependencies and remain open too.

## Audit

The existing membership periods, immutable intents, historical snapshots and
queued renewals were reused. No parallel membership system was introduced.
Primary defects were name-based person resolution, separate credit/attendance
writes, unsafe direct ledger writes and stale lifecycle documentation.

Unrelated concurrent changes to admin layout/UI, StudentList, PiecesToCollect
and the legacy lifecycle UI test were preserved and excluded from this work's
commits. Generated Supabase CLI metadata is also excluded.

## Implementation

| Issue | Status | Changes | Verification | Remaining risks / next action |
| --- | --- | --- | --- | --- |
| #2 Permissions by tenant/student/operation | Partial | Backend-provisioned exact read grants; expiring/revocable principals; negative authorization checks; server tenant checks for session/card effects | SQL permissions tests and domain contract tests | Approve business matrix #8, provisioning operator and credential lifecycle; no student self-service |
| #3 Gift identity/balance/history | Partial | Explicit same-tenant recipient ID; no name lookup/auto-person creation; guarded append-only ledger and durable receipts; repeat consume/reverse cycles; server expiry; separate payment action | Gift SQL fixtures/concurrency, client and browser tests | Real isolated staging approval; preserve/reconcile inconsistent legacy rows explicitly; old shared-key read exposes more fields than the new pilot |
| #4 Atomic reservations/attendance | Partial | Session ID/revision RPCs; whole-batch balance + attendance transaction; exact roster; original funding records; retry receipts; deterministic locks; server cup/conflict checks; Calendar integration; Dashboard opens same control | Atomic SQL fixtures/races, session client and Calendar browser tests | Approve cancellation/no-show/eligibility policy. Unknown historical funding rejects. Historical re-debit after period rollover rejects rather than charging successor. Physical deletion disabled to preserve history |
| #5 Minimal authorized domain API | Partial | Version 1 student summary / membership status; shared SQL/Edge contracts, strict fields, no administrative client key; metadata-only audit | SQL and in-memory HTTP/contract tests | Session/reservation/report read catalog, rate limits and deployed gateway validation still pending. Direct RPC calls are not covered by Edge request audit |
| #6 MCP adapter | Partial | Two read tools adapt exactly the same API; fixed destination; bounded schemas; no SQL/CRUD/write tools | Adapter contract/negative input tests | No live MCP transport/server. Agree clients, authentication/consent/revocation and run client conformance before enabling |
| #7 Integration/deployment | Partial | Reproducible isolated runners, regression suite, rollout/recovery gates | See evidence below | Real staging browser/Auth/PostgREST tests, backup restoration rehearsal and coordinated rollout remain pending. No deployment authorization inferred |

No issue was closed. Writing code is not evidence of production readiness.

## Evidence

Executed in this development session:

- `npm run test:unit`: 34/34 passed.
- `npm run test:sql:gift-cards`: passed, including real concurrent transactions.
- `npm run test:sql:sessions`: passed, including rollback of mixed funding,
  final-seat races, full-capacity edits, original-period corrections and lost replies.
- `npm run test:sql:domain-read`: passed, including revocation, injected data,
  forged scopes, minimized fields and unchanged historical snapshots.
- `npm run test:local`: 99/99 passed, including 28 Calendar/Gift browser
  tests using actual React components with synthetic callbacks.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; existing circular chunk / bundle-size warnings remain.

The SQL runners use a locally inspected `postgres:17` image, `--pull=never`,
`--network=none`, tmpfs storage and no published ports. They remove only the
container created by that invocation. They do not use host credentials or
existing clusters. Assertions with destructive fixture setup are `.psql`, not
files discovered by `supabase test db` against an application database.

`npm run test:local` additionally self-hosts a Vite test server without `.env`
loading. `operations.spec.ts` is deliberately excluded: its configured remote
fallback and broad QA cleanup are not suitable for this new development session.
No production/staging E2E or migration commands were run in this session.

## Migration Gate

Created but NOT applied remotely:

1. `20261011200000_gift_card_integrity.sql`
2. `20261011210000_authorized_read_api.sql`
3. `20261011220000_atomic_session_operations.sql`

Do not blindly push a local baseline or repair remote history. Inspect the target
schema/history with explicit authorization. Constraint replacements use
`NOT VALID` to preserve existing anomalies, not hide or delete them; inspect and
validate these constraints after reviewed reconciliation.

Deploy only alongside the matching frontend. Atomic rollout revokes old
standalone per-session gift redemption/reversal and direct session/roster DML.
Card manual consume/cancel remain card-level observations, not attendance edits.
The old frontend must not coexist with protected session projections.
The new frontend checks receipt contract availability before loading editable
views, rejecting an older backend rather than falling back to name-based writes.

Until business approval, external gift writes are disabled unless the server
explicitly sets `BONOS_WRITES_ENABLED=true`; even then standalone per-session
redeem/reverse is denied. New read principals/grants default to disabled and
must have finite expiry. No autonomous financial tools were introduced.

## Recovery

Before any authorized staging rollout, take a target-specific encrypted backup
and verify a restore in a separate isolated project. Freeze writers during a
coordinated backend/frontend switch. Do not down-migrate by dropping receipts,
membership periods or ledgers. On an uncertain response, replay the same durable
request key and exact arguments; cancellation of a network call is not rollback.

If history attribution is missing or contradicts the ledger, stop that operation
and review it explicitly. Do not infer a person, credit an unrelated successor,
clear historical archives or invent payment observations.

## Next Session

Approve the capabilities/eligibility matrix and MCP transport/client targets.
Prepare synthetic real Supabase staging, verify all target grants/triggers,
exercise browser + database + gateway jointly, rehearse backup/restore, then
request explicit migration/deployment authorization. No changes to production
are required to review this draft.
