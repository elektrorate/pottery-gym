# Agent readiness: domain integrity before integration

## Objective and authorization
Write the requested audit report, repair student lifecycle and gift-card invariants, then prepare a minimized read-only agent API pilot. User approved repository-only changes, not live migrations, deployment, production row reads or autonomous writes. MCP is a possible later adapter, not this implementation. User subsequently authorized work-unit commits, push to the `interwwweb/pottery-gym` fork and one large draft PR toward `elektrorate/pottery-gym`. No merge, deployment or remote migration application is authorized.

## Decisions and constraints
- Payment belongs to each membership period. Creation and renewal produce a new pending payment; no inferred payment from legacy status. Missing legacy payment remains unknown, not debt.
- Early renewal queues the next period for the day after the inclusive current expiry, preserving current classes/payment until then. Expired or undated legacy memberships renew from the workshop date today.
- A new period covers one exact calendar month: inclusive end is clamped one-month anniversary minus one day. Preserve outgoing periods/payment observations without fabricating receipt dates or historic transactions.
- Initial bounded implementation permits one queued successor. Remote migrations/deployment remain unauthorized.
- Expired membership does not archive a person. Preserve the existing five-day grace period as pending; day six becomes expired, not archived.
- Manual archiving/reactivation is separate from renewal/payment, including temporary students.
- Preserve one identity across membership and gift cards. Do not merge historical duplicates automatically.
- Preserve historical migrations; add non-destructive follow-up migrations only. Do not repair remote migration history automatically.
- Agent credentials stay server-side; minimize returned personal data. No generic SQL or unrestricted table-write tools.
- All delegated agents must resolve to openai-codex/gpt-6.1-sol; verify routing before launch.
- Existing UI language is Spanish. Audit report is Spanish for the requested written explanation; technical identifiers remain English.
- TDD configuration not found during exploration. Strict TDD is not enabled by test presence; ordinary regression checks required. Runner: npm run test:e2e -- tests/e2e/student-lifecycle.spec.ts. Use only local/offline tests; never remote-backed tests.
- RDD is off by session configuration. No native review launch. Assess delegated diffs and use independent verification as required.

## Tasks
- [x] T1 Write the audit report and record safe rollout boundaries. DONE: report written at `.docs/student-data-audit.md`; independent verifier PASS confirmed evidence labels, rollout boundaries, referenced paths, and no implied implementation.
- [ ] T2 Separate student lifecycle/payment/archive, fix dates and identity compatibility, update consumers and regression tests. REOPENED: prior tests passed but identity compatibility and consumer consistency are incomplete; approved per-period payment rules supersede renewal payment preservation.
- [x] T2a Add atomic membership-period persistence, queued renewal, period-specific confirmation and local SQL regression tests. DONE: writer and independent verifier passed disposable local PostgreSQL fixtures, including categories, timezone variants and concurrency. Not deployed.
- [x] T2b Integrate period/payment semantics into app mappings, renewal/confirmation/profile UI and dashboard, with offline regression checks. DONE locally: writer and independent verifier passed 31 offline tests, production build and independent TypeScript check. Browser/deployed-schema validation remains pending; ambiguous attendance credits fail closed and require an explicit reviewed class adjustment.
- [ ] T3 Repair gift-card consumption/reversal invariants, recipient checks and API validation with local regression coverage.
- [ ] T4 Prepare a minimized read-only agent API pilot, bounded credentials and contract tests; no deployment or MCP server.
- [ ] T5 Independently verify local behavior/build and document pending database/deployment validation.

## Acceptance checks
- Report distinguishes observed live catalog findings from static code findings and recommendations.
- No implicit paid state on creation/renewal; no automatic administrative archive from expiry; temporary records can be reactivated explicitly.
- Workshop date/month arithmetic clamps end of month; lifecycle consumers recognize expired separately.
- New migration keeps explicitly selected existing recipients without creating category-based duplicates; no automatic person merge.
- Gift-card repeated correction works; recipient and tenant constraints enforced in controlled operations; manual consumption aligns balance/history.
- Read-only pilot exposes only allowlisted fields, cannot invoke write operations, and uses server-owned scope.
- npm run build and focused local tests pass; skipped SQL/browser/integration checks are explicitly recorded.

## Verification and delivery
Baseline: main at c90a502, clean at start. Existing remote migration history differs (local 20261010180407 / remote 20261010180826); no history mutation authorized.
Forecast: initial estimate 800–1200 authored changed lines grew to approximately 2,540 including persistence, app integration and tests/report. User accepted a single draft with a documented size exception; work-unit commits retain tests with behavior. No artificial minification. Publication target is the user's fork; upstream write permission is not available.
Progress: report written at .docs/student-data-audit.md (155 lines, 15 referenced source paths exist). Writer runtime confirmed openai-codex/gpt-6.1-sol. Local .pi/subagents.json pins explore/worker/verify in both the original session folder and this repository. Branch feat/agent-readiness created; no commits. .gitignore now allows the report and feature document despite its existing blanket *.md rule. T1 independent verification resumed from the repository root and passed.
Checks: writer report readback/path checks passed (initial path regex false-positive corrected). Parent readback completed. Native ASSESS unavailable, requiring independent verification. Verifier PASS for T1: evidence labels, rollout boundaries, referenced paths, and no implied implementation. T2 writer self-check passed `git diff --check`; independent verifier static review passed scoped lifecycle behavior and non-destructive migration. After user-authorized `npm ci`, `npm run test:e2e -- tests/e2e/student-lifecycle.spec.ts --reporter=list` passed 11/11 and `npm run build` passed. Build emitted existing bundle-size/manualChunks warnings only. `npm ci` reported 13 vulnerabilities and install-script approval warnings; no audit fix run. Production DB application and remote-backed E2E explicitly excluded.
Rollback: preserve unrelated files; migration files remain unapplied remotely. Work-unit commits: `9b00092` (audit/report), `661edcb` (period persistence and SQL checks), `dc4d356` (app integration and offline tests). Revert only the intended unit after authorization, respecting backend/frontend rollout dependencies.
Next: close T2 gift-card recipient identity gap; plan and validate browser/deployed-schema compatibility before any authorized deployment. T3/T4 remain pending. Preserve existing config/docs/branch; no commit, remote DB access, remote migration application or deployment without explicit authorization.

### Publication verification
- Independent candidate verification: 31/31 offline tests, build, TypeScript and disposable SQL fixtures passed. ShellCheck initially found SC2155/SC2034; two mechanical runner fixes cleared both, and the runner and `git diff --check` passed again.
- Explicit staging excludes `.pi/`, `.codegraph/`, environment files and generated outputs. Targeted privacy inspection found no credential literals or local machine paths in intended files; this is not an exhaustive historical secret scan.
- Fork confirmed at `interwwweb/pottery-gym` with push access; upstream `elektrorate/pottery-gym` grants the authenticated actor read only. GitHub draft publication remains subject to its issue/approval workflow gate. No merge/deploy/migration application.

### T2a implementation evidence
- New unapplied migration: `supabase/migrations/20261011092140_student_membership_periods.sql`. Atomic pending-period creation, queued renewals, effective-date view, period confirmation, replay-safe class adjustments and protected projections.
- Known nonmembership categories remain unmanaged; NULL legacy observations remain unknown. Server-side fixed plans/prices, inclusive calendar-month terms, no automatic archive changes.
- `bash supabase/tests/run-student-membership-periods.sh` passed in writer and independent verifier runs using an existing `postgres:17` image, fresh networkless disposable container, no pulls or host ports. Fixture coverage includes DATE/timestamp/timestamptz under America/Los_Angeles and concurrent schedule/class adjustment requests.
- `git diff --check` passed. Three new files total 1,032 lines including tests/runner; behavior and security require this coherent backend unit, not cosmetic minification. No commits authorized.
- Mandatory deployment gate: old frontend is incompatible with guarded projections; do not apply migration before T2b and deployed-schema compatibility review. Fixtures do not prove production defaults/triggers/schema compatibility. Rollback boundary is only the three new unapplied migration/test/runner files; unrelated changes remain intact.

### T2b implementation evidence
- Payment NULL remains unknown, never debt. Creation maps server-returned pending period fields. Renewal uses the schedule RPC with retained request keys; queued periods keep current entitlement unchanged. Confirmation targets selected current, scheduled or historical period; profile shows period history.
- Effective/history loading is SELECT-only and fails closed on missing backend or mismatched rows. Old raw-student compatibility fallback is deliberately not supported: the app requires the new migration to be installed before use, but no installation is authorized or performed.
- Ordinary profile/archive updates stay separate; protected membership changes, payment reversal, category conversion and managed hard deletion are disabled rather than silently bypassing guards.
- Calendar/Dashboard class adjustments are period-aware and propagate errors before marking attendance complete. Partial retries retain receipt identities in same-tab sessionStorage. Attendance/session persistence is not atomic; cross-tab/operator reconciliation is not solved. Ambiguous historical credits, including corrections without durable period linkage, require an explicit reviewed class adjustment rather than automatic credit.
- Pending payments are listed by period independently of expiry; unknown legacy observations are not debt. Calendar distinguishes expired memberships from pending attendance.
- Writer and independent verifier: `npm run test:e2e -- tests/e2e/student-lifecycle.spec.ts tests/e2e/student-membership-ops.spec.ts --reporter=list` passed 31/31; `npm run build` passed with existing circular-chunk/bundle-size warnings; `git diff --check` passed. Independent verifier and parent spot check `./node_modules/.bin/tsc --noEmit` passed.
- No browser interaction, remote-backed tests, deployment or production schema validation performed. Rollback boundary: T2b app/test hunks only, preserving earlier work and unapplied SQL files. T2a+T2b must be rolled out together after validation; old frontend is incompatible with guarded projections.

### Earlier T2 implementation evidence (payment semantics superseded)
- Separated `expired` (day six onward) from explicit `archivedAt`; preserved days 1–5 pending. StudentList now exposes a separate expired filter/label; expiry no longer contributes to administrative archive counts.
- Creation defaults to payment pending in UI and operations. Renewal preserves existing payment interpretation and never clears archive. Explicit manual reactivation is available for both categories; archive/reactivation updates no longer silently retry after dropping `archived_at`.
- Shared date-only month arithmetic clamps month ends and bases terms on the Madrid workshop date or future expiry. Added a non-destructive SQL function/comment follow-up at `supabase/migrations/20261010190000_student_lifecycle_expired.sql`; historical migration unchanged, nothing applied.
- Local no-write validation: all 11 focused spec assertion bodies passed in a Node in-memory harness with Node assertions (not Playwright/browser); studentOps syntax parsed successfully. `git diff --check` passed. Initial harness attempts failed because TypeScript is not installed, Node strip-only rejects the unrelated AppView enum, and this Node version does not support transform mode; successful harness extracts the actual membership plan declaration instead.
- User authorized dependency installation; `npm ci` installed local dependencies and reported 13 vulnerabilities plus install-script approval warnings. `npm run test:e2e -- tests/e2e/student-lifecycle.spec.ts --reporter=list` passed 11/11. `npm run build` passed with existing bundle-size/manualChunks warnings. `git diff --check` passed. UI/browser interaction and SQL execution remain unverified; CalendarView's separate non-active label still reads pending and is outside the allowed surfaces. No commit, remote DB access or deployment.
