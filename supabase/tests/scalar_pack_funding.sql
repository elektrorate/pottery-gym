-- Local regression for temporal/grupal scalar pack funding (migration 20261120140000).
-- Not executed against production. Run only after applying migrations on an ephemeral DB.

create temporary table if not exists scalar_pack_funding_checks(passed boolean);

do $$
declare
  funding jsonb;
begin
  -- Placeholder documentation assertions for operators reviewing the PR.
  -- Full Auth/RPC scenarios live in the policy/manual-credit docker runners once
  -- this migration is included in their chain.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'session_business_adjust_scalar'
  ) then
    raise exception 'session_business_adjust_scalar missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'session_credit_movements_disposition_check'
      and pg_get_constraintdef(oid) like '%scalar_balance%'
  ) then
    raise exception 'scalar_balance disposition not allowed';
  end if;

  raise notice 'PASS: scalar pack funding migration objects present';
end $$;
