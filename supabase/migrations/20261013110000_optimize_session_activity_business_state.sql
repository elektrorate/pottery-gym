-- Avoid invoking the mixed-activity verifier for every ordinary session row.
-- The projection is used during the initial dashboard hydration and previously
-- evaluated private.mixed_activity_verified() twice per row, even when the
-- session class was mesa/torno/coworking. Mixed sessions still use the exact
-- same verifier and activity assignment semantics.
create or replace view public.session_activity_business_state with (security_invoker=true) as
select v.*,
  case
    when s.class_type <> 'mixto' then s.class_type
    when mixed_state.verified then e.activity_type
    else null
  end as funding_activity_type,
  r.block_id as funding_activity_block_id,
  b.teacher_id as activity_teacher_id,
  b.capacity as activity_capacity,
  case
    when s.class_type <> 'mixto' then true
    else coalesce(mixed_state.verified, false)
  end as activity_source_verified
from public.session_business_state v
join public.sessions s on s.id = v.session_id
join public.session_students e on e.session_id = v.session_id and e.student_id = v.student_id
left join public.session_activity_block_students r
  on r.session_id = e.session_id and r.student_id = e.student_id
left join public.session_activity_blocks b
  on b.id = r.block_id and b.session_id = s.id and b.sede_id = s.sede_id
left join lateral (
  select private.mixed_activity_verified(e.session_id, e.student_id) as verified
  where s.class_type = 'mixto'
) mixed_state on true
where private.session_business_read_sede(s.sede_id);
