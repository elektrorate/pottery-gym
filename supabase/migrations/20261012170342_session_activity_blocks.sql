-- Mixed sessions: one shared time window with independent activity blocks.
create table if not exists public.session_activity_blocks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  sede_id uuid not null references public.sedes(id) on delete restrict,
  activity_type text not null check (activity_type in ('mesa','torno','coworking','workshop','privada')),
  teacher_id uuid references public.teachers(id) on delete restrict,
  capacity integer not null check (capacity > 0 and capacity <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, session_id)
);

create table if not exists public.session_activity_block_students (
  block_id uuid not null references public.session_activity_blocks(id) on delete cascade,
  session_id uuid not null,
  student_id uuid not null references public.students(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (block_id, student_id),
  unique (session_id, student_id),
  foreign key (block_id, session_id) references public.session_activity_blocks(id, session_id) on delete cascade,
  foreign key (session_id, student_id) references public.session_students(session_id, student_id) on delete cascade
);

alter table public.session_activity_blocks enable row level security;
alter table public.session_activity_block_students enable row level security;

drop policy if exists session_activity_blocks_select on public.session_activity_blocks;
create policy session_activity_blocks_select on public.session_activity_blocks
  for select to authenticated using (private.can_access_sede(sede_id));
drop policy if exists session_activity_blocks_write on public.session_activity_blocks;
create policy session_activity_blocks_write on public.session_activity_blocks
  for all to authenticated using (private.can_access_sede(sede_id)) with check (private.can_access_sede(sede_id));

drop policy if exists session_activity_block_students_select on public.session_activity_block_students;
create policy session_activity_block_students_select on public.session_activity_block_students
  for select to authenticated using (exists (select 1 from public.session_activity_blocks b where b.id = block_id and private.can_access_sede(b.sede_id)));
drop policy if exists session_activity_block_students_write on public.session_activity_block_students;
create policy session_activity_block_students_write on public.session_activity_block_students
  for all to authenticated using (exists (select 1 from public.session_activity_blocks b where b.id = block_id and private.can_access_sede(b.sede_id)))
  with check (exists (select 1 from public.session_activity_blocks b where b.id = block_id and private.can_access_sede(b.sede_id)));

grant select, insert, update, delete on public.session_activity_blocks, public.session_activity_block_students to authenticated;
