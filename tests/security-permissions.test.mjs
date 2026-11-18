import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const migrations=new URL('../supabase/migrations/',import.meta.url);
test('profile grants, row isolation, defensive trigger and MFA policy',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('test.claims',true),''),'{}')::jsonb$$;
 create type public.user_role as enum('tallerista','staff','super_admin');
 create table public.profiles(id uuid primary key,email text,role public.user_role,full_name text,phone text,avatar_url text,created_at timestamptz default now(),updated_at timestamptz default now());
 create table public.sedes(id uuid primary key,owner_id uuid,name text);create table public.sede_members(id uuid primary key,user_id uuid,sede_id uuid);
 create function private.is_super_admin()returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.profiles where id=auth.uid()and role='super_admin')$$;
 grant usage on schema public,private,auth to authenticated,service_role;grant all on public.profiles to anon,authenticated,service_role;grant all on public.sedes,public.sede_members to authenticated,service_role;
 grant update(role)on public.profiles to authenticated;
 alter table public.profiles enable row level security;alter table public.sedes enable row level security;alter table public.sede_members enable row level security;
 create policy profile_read on public.profiles for select to authenticated using(id=auth.uid()or private.is_super_admin());
 create policy profile_update on public.profiles for update to authenticated using(id=auth.uid())with check(id=auth.uid());
 create policy owner_config on public.sedes to authenticated using(owner_id=auth.uid()or private.is_super_admin())with check(owner_id=auth.uid()or private.is_super_admin());
 insert into public.profiles(id,email,role,full_name)values('00000000-0000-0000-0000-000000000001','test@example.invalid','tallerista','A'),('00000000-0000-0000-0000-000000000002','other@example.invalid','super_admin','B');
 insert into public.sedes values('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','One'),('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','Two');`);
 const names=(await fs.readdir(migrations)).filter(n=>/restrict_profile_privileges|require_admin_mfa/.test(n)).sort();
 for(const n of names)await db.exec(await fs.readFile(new URL(n,migrations),'utf8'));
 await db.exec(`set test.actor='00000000-0000-0000-0000-000000000001';set test.claims='{"aal":"aal1"}';set role authenticated;`);
 for(const field of ["role='super_admin'","email='bad@example.invalid'","id='00000000-0000-0000-0000-000000000009'"])
  await assert.rejects(()=>db.exec('update public.profiles set '+field+' where id=auth.uid()'),e=>e.code==='42501');
 await assert.rejects(()=>db.exec("insert into public.profiles(id,role)values('00000000-0000-0000-0000-000000000009','super_admin')on conflict(id)do update set role=excluded.role"),e=>e.code==='42501');
 await db.exec("update public.profiles set full_name='Allowed',phone='123',avatar_url='/avatar' where id=auth.uid()");
 assert.equal((await db.query('select full_name from public.profiles where id=auth.uid()')).rows[0].full_name,'Allowed');
 assert.equal((await db.query("update public.profiles set full_name='Forbidden' where id<>'00000000-0000-0000-0000-000000000001' returning id")).rows.length,0);
 assert.equal((await db.query('select * from public.sedes')).rows.length,1);
 assert.equal((await db.query('select public.security_has_aal2() ok')).rows[0].ok,false);
 assert.equal((await db.query("update public.sedes set name='Blocked' returning id")).rows.length,0);
 await db.exec(`set test.claims='{"aal":"aal2"}';`);
 assert.equal((await db.query("update public.sedes set name='Allowed' returning id")).rows.length,1);
 await db.exec(`set test.actor='00000000-0000-0000-0000-000000000002';set test.claims='{"aal":"aal1"}';`);
 assert.equal((await db.query('select private.is_super_admin() ok')).rows[0].ok,false);
 await db.exec(`set test.claims='{"aal":"aal2"}';`);
 assert.equal((await db.query('select private.is_super_admin() ok')).rows[0].ok,true);
 await db.exec('reset role;grant update(role)on public.profiles to authenticated;set role authenticated;');
 await assert.rejects(()=>db.exec("update public.profiles set role='tallerista' where id=auth.uid()"),e=>e.code==='42501');
 await db.exec("reset role;set role service_role;update public.profiles set role='staff' where id='00000000-0000-0000-0000-000000000001';reset role;set role anon;");
 await assert.rejects(()=>db.query('select * from public.profiles'),e=>e.code==='42501');
 }finally{await db.close();}
});
