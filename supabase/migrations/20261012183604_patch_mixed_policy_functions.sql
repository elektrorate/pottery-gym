do $$
declare fn text;
begin
  foreach fn in array array[
    'private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb)',
    'private.save_session_reservation_before_manual(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb)',
    'private.session_business_funding(uuid,uuid)',
    'private.session_business_funding_before_manual(uuid,uuid)',
    'private.session_manual_credit_funding(uuid,uuid)'
  ] loop
    begin
      select pg_get_functiondef(fn::regprocedure) into fn;
      fn := replace(fn, '''mesa'', ''torno'', ''coworking''', '''mesa'', ''torno'', ''mixto'', ''coworking''');
      fn := replace(fn, '''mesa'', ''torno'', ''coworking'', ''workshop''', '''mesa'', ''torno'', ''mixto'', ''coworking'', ''workshop''');
      fn := replace(fn, 's.class_type = case when', 'coalesce(e.activity_type, s.class_type) = case when');
      fn := replace(fn, 'mc.activity = s.class_type', 'mc.activity = coalesce(e.activity_type, s.class_type)');
      execute fn;
    exception when undefined_function then null;
    end;
  end loop;
end $$;
