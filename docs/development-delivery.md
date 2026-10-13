# Domain Integrity Delivery

Current integration branch: `feat/session-policy-integration`, based on main `8dd8315`.
Prior delivery branch: `feat/domain-integrity-authorized-api`.
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
| #4 Atomic reservations/attendance | Partial, policy/manual phases verified locally | Policy2 finalization, exceptions, 8h cancellations, attributable manual credits, owner-only original-source settlement and waivers, durable ID/revision intents | 45 real local-stack scenarios, 370 regression cases, SQL preservation and races | Unknown/ambiguous legacy funds fail closed; no automatic incident settlement; remote activation/history rules remain pending |
| #5 Minimal authorized domain API | Partial | Version 1 student summary / membership status; shared SQL/Edge contracts, strict fields, no administrative client key; metadata-only audit | SQL and in-memory HTTP/contract tests | Session/reservation/report read catalog, rate limits and deployed gateway validation still pending. Direct RPC calls are not covered by Edge request audit |
| #6 MCP adapter | Partial | Two read tools adapt exactly the same API; fixed destination; bounded schemas; no SQL/CRUD/write tools | Adapter contract/negative input tests | No live MCP transport/server. Agree clients, authentication/consent/revocation and run client conformance before enabling |
| #7 Integration/deployment | Partial | Reproducible isolated runners, regression suite, local staging and logical restore rehearsal | Local Auth/PostgreSQL/Edge/browser integration and isolated restore passed | Remote staging/preview, off-host/PITR recovery and coordinated rollout remain pending. No deployment authorization inferred |

No issue was closed. Writing code is not evidence of production readiness.

## Evidence

Executed in the initial development session and local-staging follow-up:

- `npm run test:unit`: latest 40/40 passed, including three restore-tooling guards and administrative-log redaction.
- `npm run test:sql:gift-cards`: passed, including real concurrent transactions.
- `npm run test:sql:sessions`: passed, including rollback of mixed funding,
  final-seat races, full-capacity edits, original-period corrections and lost replies.
- `npm run test:sql:domain-read`: passed, including revocation, injected data,
  forged scopes, minimized fields and unchanged historical snapshots.
- `npm run test:local`: latest 524/524 passed, including mounted Auth/Data providers,
  historical hydration, actor scopes, manual credit/pagination and exact recovery.
- `npm run staging:test`: prior 45/45 real local-stack scenarios passed,
  including original-source settlement and exact replay after reload/read failure.
  These were not rerun after the provider corrections; reader expiry needs explicit
  synthetic reprovisioning approval. See `docs/provider-integrity-fixes.txt`.
- `npm run test:sql:manual-credits`: 837 isolated SQL assertions, including 339
  expected denials; 17 manual and five prior policy2 concurrent scenarios passed.
  The cold 24-migration chain includes genuine pre-integrity gift-created mirrors.
- `npm run test:sql:policy`: 275 assertions, 105 expected denials and five
  concurrent scenarios passed; old sessions/receipts retained their v1 behavior.
- The owned local Supabase schema passed `db lint`.
- Owned local `supabase test db`: 3/3 passed; all fixture writes rolled back.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; existing circular chunk / bundle-size warnings remain.
- `npm run staging:restore-rehearsal`: PASSED on 2026-10-12, full equality of
  83 tables/13,503 rows, 31 roles, schema/RLS/ACLs and 24 migrations. Restored-only
  Auth, bounded REST reads, receipt replay and desktop/mobile login passed.
  Original data remained unchanged; see `docs/restore-rehearsal.txt` for limits.

The SQL runners use a locally inspected `postgres:17` image, `--pull=never`,
`--network=none`, tmpfs storage and no published ports. They remove only the
container created by that invocation. They do not use host credentials or
existing clusters. Assertions with destructive fixture setup are `.psql`, not
files discovered by `supabase test db` against an application database.

`npm run test:local` additionally self-hosts a Vite test server without `.env`
loading. `operations.spec.ts` is deliberately excluded: its configured remote
fallback and broad QA cleanup are not suitable for this new development session.
No production/remote-staging E2E or remote migration commands were run.
The local-staging follow-up installed the schema only in its separate Docker
project, not in the existing local cluster or a hosted project.

## Migration Gate

Created but NOT applied remotely:

1. `20261011200000_gift_card_integrity.sql`
2. `20261011210000_authorized_read_api.sql`
3. `20261011220000_atomic_session_operations.sql`
4. `20261011230000_session_business_policy.sql`
5. `20261011233000_session_policy_validation_volatility.sql`
6. `20261011234000_session_policy_validation_stable.sql`
7. `20261012090000_manual_credit_reconciliation_settlement.sql`

The manual migration was applied only to the owned local stack on 2026-10-12,
after an encrypted, decryption-verified backup and preservation fingerprints.
See `docs/manual-credit-phase.txt`. Existing applied SQL files were not edited.

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

The approved local logical restore rehearsal now passes. Its encrypted archive
includes a custom dump, roles, service configuration and comparison evidence.
Restoration uses the persisted archive in a fresh tmpfs cluster, rebuilds planner
statistics, checks catalogs/data, and removes only UUID-labelled rehearsal resources.
DPAPI account recovery, external files and off-host/PITR remain separate gates.
Expired grants remain expired; they are never renewed to make a test pass.

## Next Session

Complete the financial/delegation/privacy matrix and MCP transport/client targets.
Synthetic local Supabase staging is now available; see docs/local-staging.txt.
Its 45 real scenarios passed. New sessions use policy2; pre-existing sessions
remain v1 without rebilling. Every old business observation/policy was compared
before/after local migration and preserved. Encrypted backup and decryption
were verified outside Git; an updated logical backup was restored successfully
in a separate disposable environment. This is not off-host/PITR certification.

The tests exposed and verified fixes for cumulative gift-redeem UI inference
and concurrent login authorization. Remote staging/preview integration,
off-host/productive recovery and deployment authorization remain pending.
No changes to production are required to review this draft.

Manual credit approval and pending-penalty settlement are wired into the student
profile. Only the actual sede owner can mutate; settlement cannot choose another
source. Stored actor/student-scoped intents retain original arguments through
transport loss, failed refresh, read-only recovery and full reload. Complete
paginated reads avoid the 1000-row historical truncation failure.
Private append-only gift ambiguity observations prevent legacy mirror duplication
even after recipient or label changes; observations never establish ownership.
Unknown origins require independent evidence, not automatic financial conversion.

Follow-up provider fixes preserve bounded read-only first paint while awaiting
complete financial hydration before clearing intents. Auth events defer SDK calls
outside their lock and verify the current SDK identity before applying authority.
Mixed child queries match the real composite schema; NULL gift payment remains
unknown; multi-step helpers assert actor/sede scope before subsequent writes.
Current local verification is documented in `docs/provider-integrity-fixes.txt`;
no new live Auth/RLS certification or production authorization is inferred.

Developer-only staging limitations are documented in docs/local-staging.txt:
Docker publishes service ports on all host interfaces unless the firewall
restricts access; the reader grants intentionally expire after one day; and a
Windows startup/timeouts require checking actual service health before retry.
The local runner now invokes the native binary instead of a Node shim. This tooling
must never contain real data or be exposed as a public staging service.
