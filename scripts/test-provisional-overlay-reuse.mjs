// Actual overlay implementation, instrumented DOM/background/renderer seams.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const script=await readFile(new URL('../src/content/overlay.js',import.meta.url),'utf8');
let checks=0;
function fixture(){
 const counts={build:0,erase:0,announced:0,cleared:0},routes=[];
 const rec={host:{isConnected:true},scope:{isConnected:true,firstChild:null,replaceChildren(child){this.firstChild=child}},cleanImg:{src:'blob:fixture',isConnected:true}};
 const img={naturalWidth:600,naturalHeight:1000,complete:true};
 const TP={overlayBackground:{wants:r=>r.backgroundMode==='boxes',prepare:async()=>{counts.erase++;return {url:'blob:fixture'}},apply:async()=>true,update(){}},
  overlayLocalRender:{wants:r=>!!r.lensDocument,build:async()=>{counts.build++;return {root:{innerHTML:'font-size:calc(var(--tp-font-scale,1) * 12px)'}}}},
  overlayMount:{upsertHtmlOverlay:()=>rec,scheduleHtmlOverlayUpdate(){},hideHtmlOverlay(){}},
  overlayStatus:{reason:r=>r.Ai?.meta?.skipped_reason||'',label:x=>x},ensureOverlayStyle(){},
  normUrl:x=>x,getBestImgUrl:()=>'/image',clearImageError:()=>counts.cleared++,
  emitViewerEvent:()=>counts.announced++,log:{info(){},warn(){}},traceNote:(_f,_n,d)=>routes.push(d),
  overlaySanitize:{fill(scope,html){scope.firstChild={html}}}};
 vm.runInNewContext(script,{window:{__TP:TP},WeakMap,JSON,Number,Boolean,String,Array,Set,setTimeout(){},URL:{revokeObjectURL(){}}});
 const result={lensDocument:{paragraphs:[{id:'p',text:'ไทย'}]},eraseBoxes:[{x:1}],backgroundMode:'boxes',sourceImageDataUri:'source',layout:{relayout_translated:true}};
 const apply=(value,owner='generation-A',guard=()=>true)=>TP.applyHtmlOverlay(img,value,'ai',true,'/image',guard,'trace',owner);
 return {counts,routes,rec,img,result,apply};
}
{
 const f=fixture();await f.apply({...f.result,meta:{provisional:true}});
 assert.deepEqual(f.counts,{build:1,erase:1,announced:0,cleared:1});checks++;
 const result=await f.apply({...f.result,Ai:{meta:{usage:{totalTokens:500}}},meta:{provisional:false}});
 assert.equal(result.reused,true);assert.equal(f.counts.build,1);assert.equal(f.counts.erase,1);assert.equal(f.counts.announced,1);checks+=4;
 assert.equal(f.routes.filter(d=>d.ev==='route decided').at(-1).outcome,'reused');checks++;
 const timing=f.routes.findLast(d=>d.event==='render_timing');assert.equal(timing.reused,true);assert.equal(timing.timing.backgroundMs,0);assert.equal(timing.timing.layoutMs,0);checks+=3;
 // Reuse is specifically provisional -> final, not a global skip cache.
 await f.apply(f.result);assert.equal(f.counts.build,2);checks++;
}
for(const mutation of ['text','boxes','source','layout','css','owner','detached','removed-child','clean-removed','clean-src']){
 const f=fixture();await f.apply({...f.result,meta:{provisional:true}});const next=structuredClone(f.result);
 if(mutation==='text')next.lensDocument.paragraphs[0].text='changed';
 if(mutation==='boxes')next.eraseBoxes=[];
 if(mutation==='source')next.sourceImageDataUri='changed';
 if(mutation==='layout')next.layout.relayout_translated=false;
 if(mutation==='css')next.htmlCss='.changed{}';
 if(mutation==='detached')f.rec.host.isConnected=false;
 if(mutation==='removed-child')f.rec.scope.firstChild=null;
 if(mutation==='clean-removed')f.rec.cleanImg.isConnected=false;
 if(mutation==='clean-src')f.rec.cleanImg.src='changed';
 await f.apply(next,mutation==='owner'?'generation-B':'generation-A');
 assert.equal(f.counts.build,2,mutation);checks++;
}
{
 const f=fixture();await f.apply({...f.result,meta:{provisional:true}});
 const response=await f.apply(f.result,'generation-A',()=>false);
 assert.equal(response.stale,true);assert.equal(f.counts.build,1);assert.equal(f.counts.announced,0);checks+=3;
}
console.log(`PASS ${checks} actual overlay reuse checks; final notification retained, changed geometry/content/generation reconciled, cancelled DOM rejected`);
