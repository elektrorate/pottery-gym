-- PostgreSQL's text-to-date parser is STABLE even for validated ISO input.
-- Keep this read-only validator consistent with its callees and funding reads.
alter function private.atomic_session_date(text, timestamptz, timestamptz) stable;
