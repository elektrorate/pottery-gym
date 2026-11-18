import {verifySnapshot,SNAPSHOT_TABLES} from '../utils/workshopSnapshot.ts';
const quote=(value)=>"'"+String(value).replaceAll("'","''")+"'";
const relation=table=>(table==='mixed_session_reservations'?'private.':'public.')+table;
// Generates SQL only. Requires an explicitly marked, empty, isolated database.
export async function isolatedRestoreSql(input){
const copy=await verifySnapshot(input);
const tables=SNAPSHOT_TABLES.map(relation);
return `BEGIN;
SET LOCAL lock_timeout='10s';
DO $guard$ BEGIN IF current_setting('pottery.restore_target',true) IS DISTINCT FROM 'isolated' THEN RAISE EXCEPTION 'Restore requires an explicitly marked isolated target'; END IF; END $guard$;
${tables.map(t=>'LOCK TABLE '+t+' IN ACCESS EXCLUSIVE MODE;').join('\n')}
${tables.map(t=>'DO $empty$ BEGIN IF EXISTS(SELECT 1 FROM '+t+') THEN RAISE EXCEPTION '+quote('Target must be empty: '+t)+'; END IF; END $empty$;').join('\n')}
CREATE TEMP TABLE restore_fk_contract ON COMMIT DROP AS SELECT conrelid,conname,condeferrable,condeferred FROM pg_constraint WHERE contype='f' AND conrelid IN (${tables.map(t=>quote(t)+'::regclass').join(',')});
DO $defer$ DECLARE c record; BEGIN FOR c IN SELECT * FROM restore_fk_contract LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',c.conrelid::regclass,c.conname); END LOOP; END $defer$;
${tables.map(t=>'ALTER TABLE '+t+' DISABLE TRIGGER USER;').join('\n')}
${SNAPSHOT_TABLES.map(t=>copy.data[t].length?'INSERT INTO '+relation(t)+' OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::'+relation(t)+','+quote(JSON.stringify(copy.data[t]))+'::jsonb);':'-- Empty: '+t).join('\n')}
DO $sequences$ DECLARE c record; seq text; high bigint; BEGIN FOR c IN SELECT a.attrelid,a.attname FROM pg_attribute a WHERE a.attrelid IN (${tables.map(t=>quote(t)+'::regclass').join(',')}) AND a.attnum>0 AND NOT a.attisdropped LOOP seq:=pg_get_serial_sequence(c.attrelid::regclass::text,c.attname); IF seq IS NOT NULL THEN EXECUTE format('SELECT max(%I) FROM %s',c.attname,c.attrelid::regclass) INTO high; IF high IS NOT NULL AND high>0 THEN PERFORM pg_catalog.setval(seq::regclass,high,true); END IF; END IF; END LOOP; END $sequences$;
SET CONSTRAINTS ALL IMMEDIATE;
${tables.map(t=>'ALTER TABLE '+t+' ENABLE TRIGGER USER;').join('\n')}
DO $restore$ DECLARE c record; BEGIN FOR c IN SELECT * FROM restore_fk_contract LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I %s',c.conrelid::regclass,c.conname,CASE WHEN c.condeferrable THEN 'DEFERRABLE INITIALLY '||CASE WHEN c.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END ELSE 'NOT DEFERRABLE' END); END LOOP; END $restore$;
${SNAPSHOT_TABLES.map(t=>'DO $count$ BEGIN IF (SELECT count(*) FROM '+relation(t)+') <> '+copy.manifest[t]+' THEN RAISE EXCEPTION '+quote('Count mismatch: '+t)+'; END IF; END $count$;').join('\n')}
COMMIT;
`;
}
