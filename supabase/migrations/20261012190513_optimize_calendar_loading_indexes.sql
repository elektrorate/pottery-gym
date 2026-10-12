-- Keep the initial calendar snapshot fast without changing RLS or result shape.
create index if not exists sessions_sede_date_idx
  on public.sessions (sede_id, date, start_time);
create index if not exists session_students_session_student_idx
  on public.session_students (session_id, student_id);
create index if not exists session_students_sede_idx
  on public.session_students (sede_id, session_id);
create index if not exists session_activity_blocks_session_idx
  on public.session_activity_blocks (session_id, sede_id);
create index if not exists session_activity_block_students_session_idx
  on public.session_activity_block_students (session_id, block_id, student_id);
create index if not exists students_sede_id_idx
  on public.students (sede_id, id);
create index if not exists teachers_sede_id_idx
  on public.teachers (sede_id, id);
