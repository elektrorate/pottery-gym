import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
test('agenda SQL: isolation, receipts, stale edits, validation and recoverable deletion', async () => {
const db=new PGlite();
await db.exec(`create role authenticated;create role anon; create schema auth; create schema private;create table public.profiles(id uuid primary key);create table public.sedes(id uuid primary key,owner_id uuid);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create function private.can_access_sede(s uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.sedes where id=s and owner_id=auth.uid()) $$;grant usage on schema public,auth,private to authenticated,anon;grant select on public.sedes,public.profiles to authenticated;insert into profiles values('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');insert into sedes values('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002');`);
await db.exec(await fs.readFile(new URL('../supabase/migrations/20261118135426_shared_workshop_agenda.sql',import.meta.url),'utf8'));
await db.exec("set role authenticated;set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';");
const sede='10000000-0000-0000-0000-000000000001', id='20000000-0000-0000-0000-000000000001';
const payload={title:'PRUEBA AISLADA',activity_date:'2026-11-18',starts_at:'10:00',ends_at:'11:00',description:'Solo base local'};
const call=async(request,revision,action,body=payload,s=sede)=> (await db.query('select public.save_workshop_activity($1,$2,$3,$4,$5,$6::jsonb) as r',[s,id,request,revision,action,JSON.stringify(body)])).rows[0].r;
const req='30000000-0000-0000-0000-000000000001';
const first=await call(req,0,'create');assert.equal(first.revision,0);assert.deepEqual(await call(req,0,'create'),first);
await assert.rejects(()=>call(req,0,'create',{...payload,title:'Changed'}));
await assert.rejects(()=>call('30000000-0000-0000-0000-000000000002',0,'create',payload,'10000000-0000-0000-0000-000000000002'));
const updated=await call('30000000-0000-0000-0000-000000000003',0,'update',{...payload,title:'Editado'});assert.equal(updated.revision,1);
await assert.rejects(()=>call('30000000-0000-0000-0000-000000000004',0,'update'));
const deleted=await call('30000000-0000-0000-0000-000000000005',1,'delete',{});assert.ok(deleted.deleted_at);
assert.deepEqual(await call('30000000-0000-0000-0000-000000000005',1,'delete',{}),deleted);
const restored=await call('30000000-0000-0000-0000-000000000006',2,'restore',{});assert.equal(restored.deleted_at,null);
await assert.rejects(()=>call('30000000-0000-0000-0000-000000000007',3,'update',{...payload,ends_at:'09:00'}));
assert.equal(Number((await db.query('select count(*) c from workshop_activity_events')).rows[0].c),4);
await db.exec("set request.jwt.claim.sub='00000000-0000-0000-0000-000000000002'");assert.equal((await db.query('select * from workshop_activities')).rows.length,0);
await db.close();console.log('Agenda SQL: creación, reintento exacto, conflicto, aislamiento, edición, revisión obsoleta, borrado, reintento de borrado, restauración, horario inválido y auditoría verificados.');

});
