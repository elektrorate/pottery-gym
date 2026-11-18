import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSectionState, describeLoadError } from '../utils/sectionLoading.ts';
import { studentBalanceLabel, hasVerifiedMembership, needsStudentReview } from '../utils/studentPresentation.ts';
import { SNAPSHOT_TABLES, sealSnapshot, verifySnapshot, compareSnapshots } from '../utils/workshopSnapshot.ts';

const sede='10000000-0000-0000-0000-000000000001';
const emptyCopy=()=>({format:'pottery-workshop-snapshot',version:1,scope:'workshop-business-data',sede_id:sede,manifest:Object.fromEntries(SNAPSHOT_TABLES.map(table=>[table,0])),data:Object.fromEntries(SNAPSHOT_TABLES.map(table=>[table,[]]))});
const makeCopy=()=>{const copy=emptyCopy();copy.data.sedes=[{id:sede}];copy.manifest.sedes=1;return copy;};

test('loading and refreshing preserve the distinction between no read and a verified empty read',()=>{
  assert.deepEqual(nextSectionState(undefined),{status:'loading',hasData:false,error:undefined});
  assert.equal(nextSectionState({status:'error',hasData:true,error:'failed'}).status,'refreshing');
  assert.equal(nextSectionState({status:'ready',hasData:true}).hasData,true);
  assert.match(describeLoadError({code:'42501'}),/permiso/);
  assert.match(describeLoadError({message:'network timeout'}),/conexión/);
  assert.match(describeLoadError({code:'42P01'}),/compatible/);
});
test('imported credits never invent a plan denominator or establish payment',()=>{
  const imported={id:'student',name:'Alumno',phone:'',status:'membresia',studentCategory:'membresia',classesRemaining:7,legacyManualBalance:7,price:120,paymentStatus:null};
  assert.equal(studentBalanceLabel(imported),'Saldo importado: 7 clases');
  assert.equal(hasVerifiedMembership(imported),false);assert.equal(needsStudentReview(imported),true);
  assert.equal(needsStudentReview({...imported,archivedAt:'2026-11-18'}),false);
  assert.equal(studentBalanceLabel({...imported,legacyManualBalance:null}),'Saldo por verificar');
  const confirmed={...imported,effectivePeriodId:'period',membershipTier:'gold',bonosAsignados:4,classesRemaining:3,paymentStatus:'paid',expiryDate:'2026-12-18'};
  assert.equal(studentBalanceLabel(confirmed),'3 / 4');assert.equal(needsStudentReview(confirmed),false);
});
test('recovery copies detect tampering, missing entities, mismatched counts and broken references',async()=>{
  const copy=makeCopy();copy.data.students=[{id:'s1',sede_id:sede,name:'Original'}];copy.manifest.students=1;
  const sealed=await sealSnapshot(copy);await verifySnapshot(sealed);
  const tampered=structuredClone(sealed);tampered.data.students[0].name='Changed';await assert.rejects(()=>verifySnapshot(tampered),/integridad/);
  const missing=makeCopy();delete missing.data.sessions;await assert.rejects(()=>sealSnapshot(missing),/entidades/);
  const wrong=makeCopy();wrong.manifest.students=1;await assert.rejects(()=>sealSnapshot(wrong),/Recuento/);
  const foreign=makeCopy();foreign.data.students=[{id:'s1',sede_id:'other'}];foreign.manifest.students=1;await assert.rejects(()=>sealSnapshot(foreign),/otra sede/);
  const orphan=makeCopy();orphan.data.session_students=[{id:'r1',sede_id:sede,student_id:'missing',session_id:'missing'}];orphan.manifest.session_students=1;await assert.rejects(()=>sealSnapshot(orphan),/Referencia ausente/);
});
test('simulation identifies changes without modifying either copy or dropping destination-only rows',async()=>{
  const current=makeCopy();current.data.students=[{id:'s1',sede_id:sede,name:'Current'},{id:'s2',sede_id:sede,name:'Keep'}];current.manifest.students=2;
  const incoming=makeCopy();incoming.data.students=[{id:'s1',sede_id:sede,name:'Old'},{id:'s3',sede_id:sede,name:'New'}];incoming.manifest.students=2;
  const before=JSON.stringify(current);const comparison=compareSnapshots(await sealSnapshot(current),await sealSnapshot(incoming)).find(row=>row.table==='students');
  assert.deepEqual(comparison,{table:'students',added:1,changed:1,identical:0,destinationOnly:1});assert.equal(JSON.stringify(current),before);
  const other=makeCopy();other.sede_id='another';other.data.sedes=[{id:'another'}];
  assert.throws(()=>compareSnapshots(current,other),/otra sede/);
});
