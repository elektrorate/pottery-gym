# Workshop recovery copies

The Excel export is for consultation. The JSON export is a consistent row snapshot of 34 scoped business entities, including settings, receipts and protected history. Auth users/sessions, credentials, Storage files, integration authorizations and transient transaction writer rows are excluded. Existing Auth/profile identities are required. SHA-256 detects content changes; it is not a digital signature.

## Before restoration

1. Download and preserve a verified copy of the destination.
2. Verify the incoming checksum, identifiers, relationships and sede. Use the read-only Settings comparison to review differences and destination-only records.
3. Obtain approval for a concrete recovery plan. Production restoration is never automatic.
4. Rehearse against a separate, empty database with the same reviewed migrations and required existing identities. Do not run the reconstruction baseline against production.

## Isolated restore generator

Node 24 can import scripts/isolated-restore.mjs. Call isolatedRestoreSql(parsedVerifiedCopy), save the returned SQL, and review it. It does not connect to a database. SQL requires the explicit session setting pottery.restore_target=isolated and rejects any nonempty business target. It preserves identity values and advances their sequences, defers and revalidates foreign keys, temporarily disables user business triggers to avoid charging historical attendance, then restores constraints/triggers before committing. Run only against a separate test database as its schema owner. Existing target identities are not changed.

The generated SQL is a clean-target rehearsal tool, not a merge into a live workshop. Conflicting live records require a separately approved reconciliation. PostgreSQL sequence advancement is not transactional; a failed restore may leave harmless sequence gaps.

## Verification

- node --test tests/workshop-reliability.test.mjs tests/shared-agenda.test.mjs tests/workshop-snapshot-sql.test.mjs
- node tests/run-local-regression.mjs
- node tests/full-schema-recovery-check.mjs CURRENT_SNAPSHOT_JSON APPROVED_RECOVERY_SQL

The last check uses the local reconstruction baseline plus subsequent migrations in embedded PostgreSQL, creates fictitious matching Auth/profile identities, restores current rows, compares canonical checksums per entity, then verifies the reviewed provenance-only SQL changes no balances, history or settings. It never connects to Supabase. It expects the pre-recovery administrative snapshot format (schema-qualified data keys), not a historical data source.

## Rollout and rollback

Review the remote migration history first. Apply only the new shared Agenda, recovery snapshot and imported-session provenance migrations. Preserve all existing migrations and the bonos designer. Do not blindly push the reconstruction baseline. After approved deployment, verify owner/staff access, section retries, two authorized clients reading the same Agenda activity and deep links.

If the UI needs rollback, redeploy the previous frontend while preserving new tables, receipts, activity history and provenance columns. Export all new data first. Never drop the new tables to roll back a visual issue. Correct imported provenance only with a reviewed conditional update matching the exact source and prior values; do not restore the whole database over newer user changes.
