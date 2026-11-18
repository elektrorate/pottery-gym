begin;
alter table public.sessions add column imported_completed boolean;
alter table public.sessions add column import_source text;
alter table public.sessions add constraint sessions_import_provenance_pair check ((imported_completed is null)=(import_source is null));
comment on column public.sessions.imported_completed is 'Original source completion flag only. Does not establish attendance, formal closure or credit movements.';
comment on column public.sessions.import_source is 'Auditable import source and worksheet row; no payment inference.';
commit;
