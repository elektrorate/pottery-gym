import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mocks = fileURLToPath(new URL('./fixtures/gift-card-ops-mocks.ts', import.meta.url));
const output = await build({ absWorkingDir: root,
  stdin: { contents: `export * as pieces from './context/data/pieceOps'; export * as teachers from './context/data/teacherOps'; export * as inventory from './context/data/inventoryOps'; export * from './utils/recordPresentation';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'offline-network-boundaries', setup(builder) {
    builder.onResolve({ filter: /supabaseClient$|\/toast$/ }, () => ({ path: mocks }));
  } }]
});
const ops = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
let harness, ctx, state;
beforeEach(() => {
  state = { pieces: [{ id:'piece', status:'1era_quema', glazeType:'Transparente', notes:'Conservar', deliveryDate:'2026-12-01' }], items:[{id:'item',current_quantity:10}], movements:[] };
  harness = { calls:[], errors:[], warnings:[], result:{data:null,error:null},
    from(table) {
      const call={table}; this.calls.push(call);
      const query={ update(payload){call.update=payload;return query;},insert(payload){call.insert=payload;return query;},eq(){return query;},select(){return query;},single(){return Promise.resolve(harness.result);},
        then(resolve,reject){return Promise.resolve(harness.result).then(resolve,reject);} };
      return query;
    },
    rpc(name,args){this.calls.push({name,args});return Promise.resolve(this.result);}
  };
  globalThis.__giftCardHarness=harness;
  ctx={ assertScope(){},sedeId:'tenant',students:[],get pieces(){return state.pieces;},
    setPieces(fn){state.pieces=typeof fn==='function'?fn(state.pieces):fn;},setInventoryItems(fn){state.items=fn(state.items);},setInventoryMovements(fn){state.movements=fn(state.movements);},
    setTeachers(){},safeReload:async()=>{} };
});
test('advancing a piece preserves omitted metadata in the real update payload and UI',async()=>{
  await ops.pieces.updatePiece(ctx,'piece',{status:'esmaltado'});
  assert.deepEqual(harness.calls[0].update,{status:'esmaltado'});
  assert.equal(state.pieces[0].glazeType,'Transparente');
  assert.equal(state.pieces[0].notes,'Conservar');
});
test('explicitly clearing metadata is distinct from omitting it',async()=>{
  await ops.pieces.updatePiece(ctx,'piece',{glazeType:'',notes:'',deliveryDate:'',extraCommentary:''});
  assert.deepEqual(harness.calls[0].update,{glaze_type:null,notes:null,delivery_date:null,extra_commentary:null});
});
test('failed piece update reverts its optimistic state and rejects the form submission',async()=>{
  harness.result.error=new Error('denied');
  await assert.rejects(ops.pieces.updatePiece(ctx,'piece',{status:'esmaltado'}),/denied/);
  assert.equal(state.pieces[0].status,'1era_quema');
});
test('failed teacher creation rejects instead of reporting a successful save',async()=>{
  harness.result.error=new Error('network rejected');
  await assert.rejects(ops.teachers.addTeacher(ctx,{name:'Test'}),/network rejected/);
});
const movement=()=>({item_id:'item',requestKey:'request',expectedQuantity:10,type:'in',quantity:3,new_quantity:999,unit:'kg',reason:'test',date:'2026-11-17'});
test('inventory uses one atomic RPC and renders the server balance rather than the client projection',async()=>{
  harness.result.data={id:'request',item_id:'item',new_quantity:13};
  await ops.inventory.addInventoryMovement(ctx,movement());
  assert.equal(harness.calls.length,1);
  assert.equal(harness.calls[0].name,'record_inventory_movement');
  assert.equal(harness.calls[0].args.p_new_quantity,null);
  assert.equal(harness.calls[0].args.p_expected_quantity,10);
  assert.equal(state.items[0].current_quantity,13);
  await ops.inventory.addInventoryMovement(ctx,movement());
  assert.equal(harness.calls[1].args.p_request_id,'request');
  assert.equal(state.movements.length,1);
});
test('rejected inventory writes never update balances or add a movement locally',async()=>{
  harness.result.error={message:'Insufficient stock',code:'22023'};
  await assert.rejects(ops.inventory.addInventoryMovement(ctx,movement()));
  assert.equal(state.items[0].current_quantity,10);
  assert.equal(state.movements.length,0);
});
test('unconfirmed inventory responses retain the form instead of claiming success',async()=>{
  await assert.rejects(ops.inventory.addInventoryMovement(ctx,movement()),/confirmar/);
});
test('cancelled reservation takes precedence over provisional attendance',()=>{
  assert.equal(ops.getStudentSessionStatus({attendanceByStudentId:{student:'present'},businessStateByStudentId:{student:{reservationState:'cancelled'}}},'student',[]),'Cancelada');
});
test('attendance is provisional until finalized and identities do not fall back to duplicate names',()=>{
  const session={studentIds:['student'],attendanceByStudentId:{student:'present'}};
  assert.equal(ops.getStudentSessionStatus(session,'student',[]),'Asistencia provisional');
  assert.equal(ops.getStudentSessionStatus({...session,completedAt:'2026-11-17'},'student',[]),'Asistió');
  assert.equal(ops.getStudentSessionStatus({studentIds:['other'],attendance:{ALEX:'present'}},'student',['Alex']),'Pendiente');
});
test('pending or unknown payment never appears active, while terminal states remain terminal',()=>{
  const card={numClasses:2,sessionsUsed:0,status:'pending',paymentStatus:'pending'};
  assert.equal(ops.getGiftCardLifecycle(card,'2026-11-17'),'pending');
  assert.equal(ops.getGiftCardLifecycle({...card,status:'active',paymentStatus:'paid'},'2026-11-17'),'active');
  assert.equal(ops.getGiftCardLifecycle({...card,status:'active',paymentStatus:null},'2026-11-17'),'pending');
  assert.equal(ops.getGiftCardLifecycle({...card,status:'cancelled'},'2026-11-17'),'cancelled');
  assert.equal(ops.getGiftCardLifecycle(card,'2026-11-17','2026-11-16'),'expired');
});
test('credit rejection is translated without losing unrelated technical errors',()=>{
  assert.match(ops.sessionBusinessErrorMessage(new Error('Presence requires valid original credit or an explicit current session exception: unpaid')),/No se puede finalizar/);
  assert.equal(ops.sessionBusinessErrorMessage(new Error('Other failure')),'Other failure');
});
