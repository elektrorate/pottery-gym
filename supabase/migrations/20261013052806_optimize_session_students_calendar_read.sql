-- Supports the calendar roster read: tenant filter plus stable pagination order.
-- This is intentionally additive; existing write and integrity indexes remain unchanged.
create index if not exists session_students_calendar_read_idx
  on public.session_students (sede_id, session_id, student_id);
