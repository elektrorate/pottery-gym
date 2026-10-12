-- This validator reads only its finite ISO date/time arguments. Marking it
-- immutable keeps the read-only funding function genuinely STABLE.
alter function private.atomic_session_date(text, timestamptz, timestamptz) immutable;
