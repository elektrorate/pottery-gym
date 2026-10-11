#!/usr/bin/env bash
set -euo pipefail
# Fresh fixtures only: never consume DB_URL, host credentials, existing clusters,
# containers or volumes. Docker fallback is local-image-only and networkless.
root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${PG_BIN_DIR:-/opt/homebrew/bin}"
scratch="$(mktemp -d /tmp/membership-periods.XXXXXX)"
container=''
host_started=false
# Git Bash converts Linux-looking Docker paths to Windows paths. Keep paths
# inside the disposable container untouched, converting only local copy sources.
if command -v cygpath >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1
  docker_cp() {
    local source
    source="$(cygpath -w "$1")"
    docker cp "$source" "$2"
  }
else
  docker_cp() { docker cp "$1" "$2"; }
fi
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if [[ "$host_started" = true ]]; then
    "$bin/pg_ctl" -D "$scratch/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  # Only this invocation's freshly allocated directory is removed.
  if [[ "$scratch" == /tmp/membership-periods.* && -d "$scratch" ]]; then rm -rf -- "$scratch"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
resolved_initdb="$bin/initdb"
while [[ -L "$resolved_initdb" ]]; do
  target="$(readlink "$resolved_initdb")"
  if [[ "$target" = /* ]]; then resolved_initdb="$target";
  else resolved_initdb="$(dirname "$resolved_initdb")/$target"; fi
done
migrations=("$root"/supabase/migrations/*_student_membership_periods.sql)
if [[ ${#migrations[@]} != 1 || ! -f "${migrations[0]}" ]]; then
  echo 'Expected exactly one membership-period migration' >&2; exit 1
fi
if [[ -x "$resolved_initdb" && -x "$(dirname "$resolved_initdb")/postgres" && -x "$bin/pg_ctl" && -x "$bin/psql" ]]; then
  echo 'Using disposable host PostgreSQL cluster'
  mkdir "$scratch/socket"
  "$bin/initdb" -D "$scratch/data" --auth=trust --no-locale >/dev/null
  host_started=true
  "$bin/pg_ctl" -D "$scratch/data" -l "$scratch/postgres.log" \
    -o "-c listen_addresses='' -c unix_socket_directories='$scratch/socket'" -w start >/dev/null
  PGUSER="$(id -un)"
  export PGHOST="$scratch/socket" PGPORT=5432 PGDATABASE=postgres PGUSER
  unset PGHOSTADDR PGSERVICE PGPASSWORD PGOPTIONS
  export PGPASSFILE="$scratch/no-password-file" PGSERVICEFILE="$scratch/no-service-file"
  psql=("$bin/psql" -X -w -v ON_ERROR_STOP=1 -h "$scratch/socket" -d postgres)
  migration="${migrations[0]}"
  fixture="$root/supabase/tests/student_membership_periods.fixture.psql"
else
  echo 'Using existing postgres:17 image in a disposable networkless container'
  image="$(docker image inspect postgres:17 --format '{{.Id}}')"
  if [[ "$image" != sha256:2d2b8998d310* ]]; then
    echo 'Expected parent-authorized local postgres:17 image 2d2b8998d310' >&2; exit 1
  fi
  container="$(docker run -d --pull=never --network=none \
    --name "$(basename "$scratch")" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$image" postgres -c listen_addresses='')"
  ready=false
  for _attempt in {1..60}; do
    # Wait for the final server, not the entrypoint's temporary bootstrap server.
    if docker exec "$container" bash -c 'read -r process </proc/1/comm; [[ "$process" == postgres ]]' \
      && docker exec "$container" pg_isready -U postgres -h /var/run/postgresql >/dev/null 2>&1; then
      ready=true; break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then docker logs "$container"; exit 1; fi
  docker_cp "${migrations[0]}" "$container:/tmp/period-migration.sql"
  docker_cp "$root/supabase/tests/student_membership_periods.fixture.psql" "$container:/tmp/period-fixture.sql"
  psql=(docker exec -i "$container" psql -X -w -U postgres -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1)
  migration=/tmp/period-migration.sql
  fixture=/tmp/period-fixture.sql
fi
for expiry_type in timestamptz date timestamp; do
  echo "Fixture expiry type: $expiry_type, timezone: America/Los_Angeles"
  "${psql[@]}" -v expiry_type="$expiry_type" -v migration="$migration" -f "$fixture"
done
# Two real transactions serialize on the same student and replay one receipt.
"${psql[@]}" >"$scratch/schedule-a.log" 2>&1 <<'SQL' &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000009',
  '20000000-0000-0000-0000-000000000009', 'gold', 4);
select pg_sleep(1);
commit;
SQL
first=$!
"${psql[@]}" >"$scratch/schedule-b.log" 2>&1 <<'SQL' &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000009',
  '20000000-0000-0000-0000-000000000009', 'gold', 4);
commit;
SQL
second=$!
if ! wait "$first" || ! wait "$second"; then
  printf '%s\n' 'Concurrent scheduling failed';
  while IFS= read -r line; do printf '%s\n' "$line"; done <"$scratch/schedule-a.log"
  while IFS= read -r line; do printf '%s\n' "$line"; done <"$scratch/schedule-b.log"
  exit 1
fi
"${psql[@]}" <<'SQL'
select public.test_assert(count(*) = 1, 'concurrent identical schedule creates one period')
from public.student_membership_periods where request_key = '20000000-0000-0000-0000-000000000009';
SQL
# Competing distinct adjustments both expect 3. Exactly one may consume a class.
for key in 91 92; do
  "${psql[@]}" >"$scratch/adjust-$key.log" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select public.adjust_student_membership_classes(id,current_membership_period_id,
  '40000000-0000-0000-0000-0000000000$key',3,-1)
from public.students where id='10000000-0000-0000-0000-000000000002';
select pg_sleep(1);
commit;
SQL
  if [[ "$key" = 91 ]]; then first=$!; else second=$!; fi
done
failures=0
wait "$first" || failures=$((failures+1))
wait "$second" || failures=$((failures+1))
if [[ "$failures" != 1 ]]; then echo 'Expected exactly one stale competing adjustment' >&2; exit 1; fi
if ! grep -q 'Stale class balance' "$scratch/adjust-91.log" "$scratch/adjust-92.log"; then
  echo 'Competing adjustment did not fail with expected stale-balance error' >&2; exit 1
fi
"${psql[@]}" <<'SQL'
select public.test_assert(classes_remaining=2, 'concurrent consumption cannot overwrite/refill balance')
from public.students where id='10000000-0000-0000-0000-000000000002';
select public.test_assert(count(*)=1, 'one concurrent adjustment receipt')
from public.student_membership_class_adjustments where request_key in
  ('40000000-0000-0000-0000-000000000091','40000000-0000-0000-0000-000000000092');
SQL
echo 'PASS: membership-period fixtures, concurrent schedule and class consumption'
