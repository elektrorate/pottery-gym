import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const output=await build({stdin:{contents:"export * from './bonos-designer/lib/cacheScope';export * from './bonos-designer/lib/localHistory';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const m=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
test('cache isolates users and workshops, rejects unscoped history and clears private state',()=>{
 const storage={};Object.defineProperty(storage,'getItem',{value:k=>storage[k]??null});Object.defineProperty(storage,'setItem',{value:(k,v)=>{storage[k]=v;}});Object.defineProperty(storage,'removeItem',{value:k=>{delete storage[k];}});
 globalThis.window={localStorage:storage};
 const a={userId:'a',sedeId:'one'},b={userId:'b',sedeId:'one'},c={userId:'a',sedeId:'two'};
 const record={id:'r',createdAt:new Date().toISOString(),fileName:'test.pdf',status:'created',voucherCode:'fictional',data:{buyerName:'PRUEBA CODEX'}};
 m.saveLocalHistory([record],a);assert.equal(m.loadLocalHistory(a).length,1);assert.deepEqual(m.loadLocalHistory(b),[]);assert.deepEqual(m.loadLocalHistory(c),[]);assert.deepEqual(m.loadLocalHistory(null),[]);
 storage.setItem('casa-rosier-gift-card-history-v1',JSON.stringify([record]));storage.setItem('barro-co-theme','dark');m.removeUnscopedDesignerCaches();assert.equal(storage.getItem('casa-rosier-gift-card-history-v1'),null);assert.equal(m.loadLocalHistory(a).length,1);
 for(const kind of ['draft','templates'])storage.setItem(m.designerStorageKey(kind,a),'PRIVATE');m.clearDesignerCaches();assert.deepEqual(m.loadLocalHistory(a),[]);assert.equal(storage.getItem('barro-co-theme'),'dark');assert.equal(Object.keys(storage).length,1);delete globalThis.window;
});
