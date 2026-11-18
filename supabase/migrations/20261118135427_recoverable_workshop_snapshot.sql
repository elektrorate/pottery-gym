begin;
create function private.export_workshop_snapshot(p_sede_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare table_name text; rows_json jsonb; data_json jsonb:='{}'; manifest_json jsonb:='{}';
begin
  if auth.uid() is null or not exists(select 1 from public.sedes where id=p_sede_id and owner_id=auth.uid()) then raise exception 'Only the workshop owner may export a recovery copy' using errcode='42501'; end if;
  foreach table_name in array array['students','teachers','sessions','session_students','student_membership_periods','student_membership_class_adjustments','student_manual_credit_entitlements','student_penalty_settlements','student_assigned_classes','gift_cards','gift_card_movements','gift_card_operation_receipts','session_credit_movements','session_operation_receipts','session_business_events','session_business_exceptions','session_business_billing','session_business_penalties','session_business_waivers','session_activity_blocks','inventory_items','inventory_movements','payments','pieces','workshop_schedules','workshop_capacity_defaults','workshop_schedule_exceptions','sede_members','workshop_activities','workshop_activity_events'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t where sede_id=$1',table_name) into rows_json using p_sede_id;
    data_json:=data_json||jsonb_build_object(table_name,rows_json);
    manifest_json:=manifest_json||jsonb_build_object(table_name,jsonb_array_length(rows_json));
  end loop;
  select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') into rows_json from public.sedes t where id=p_sede_id;
  data_json:=data_json||jsonb_build_object('sedes',rows_json); manifest_json:=manifest_json||jsonb_build_object('sedes',jsonb_array_length(rows_json));
  select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') into rows_json from public.packages t where student_id in(select id from public.students where sede_id=p_sede_id);
  data_json:=data_json||jsonb_build_object('packages',rows_json); manifest_json:=manifest_json||jsonb_build_object('packages',jsonb_array_length(rows_json));
  select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') into rows_json from public.session_activity_block_students t where session_id in(select id from public.sessions where sede_id=p_sede_id);
  data_json:=data_json||jsonb_build_object('session_activity_block_students',rows_json);manifest_json:=manifest_json||jsonb_build_object('session_activity_block_students',jsonb_array_length(rows_json));
  select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') into rows_json from private.mixed_session_reservations t where sede_id=p_sede_id;
  data_json:=data_json||jsonb_build_object('mixed_session_reservations',rows_json);manifest_json:=manifest_json||jsonb_build_object('mixed_session_reservations',jsonb_array_length(rows_json));
  return jsonb_build_object('format','pottery-workshop-snapshot','version',1,'scope','workshop-business-data','sede_id',p_sede_id,'created_at',now(),'timezone','Europe/Madrid','requires_existing_identities',true,'excluded',jsonb_build_array('Auth users and sessions','Credentials and API keys','Storage object files','Private integration authorizations','Transient transaction writers'),'manifest',manifest_json,'data',data_json);
end $$;
revoke all on function private.export_workshop_snapshot(uuid) from public,anon;
grant execute on function private.export_workshop_snapshot(uuid) to authenticated;
create function public.export_workshop_snapshot(p_sede_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select private.export_workshop_snapshot(p_sede_id); $$;
revoke all on function public.export_workshop_snapshot(uuid) from public,anon;
grant execute on function public.export_workshop_snapshot(uuid) to authenticated;
commit;
