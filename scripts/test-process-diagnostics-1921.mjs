// Real page tracing/erase and Lens transport; browser canvas/network surfaces are fixtures.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
let checks=0;
function equal(a,b,m){assert.deepEqual(a,b,m);checks++;}
const messages=[],listeners=new Set();
const doc={visibilityState:'visible',addEventListener:(name,fn)=>{equal(name,'visibilitychange');listeners.add(fn);},removeEventListener:(_n,fn)=>listeners.delete(fn)};
const context=vm.createContext({window:{__TP:{}},document:doc,Element:class{},Date,Math,TextEncoder,crypto:globalThis.crypto,
 chrome:{runtime:{lastError:null,sendMessage:(msg,cb)=>{messages.push(msg);cb?.();}}}});
vm.runInContext(source('src/shared/diagnostic-schema.js'),context);
vm.runInContext(source('src/content/trace.js'),context);
const TP=context.window.__TP;
equal(messages.length,0,'disabled tracing sends nothing');
TP.setTracingEnabled(true);TP.setTracingEnabled(true);
equal(listeners.size,1,'passive repeated enable does not add listeners');
equal(messages.length,1,'one initial state, not one per UI refresh');
equal(messages[0].record.d.hidden,false);
doc.visibilityState='hidden';for(const fn of listeners)fn();
doc.visibilityState='visible';for(const fn of listeners)fn();
equal(TP.getVisibilityEpoch(),2);
equal(messages.slice(1).map(m=>m.record.d.hidden),[true,false]);
equal(new Set(messages.map(m=>m.record.producerId)).size,1);
equal(messages.every(m=>m.record.d.event==='page_visibility' && m.record.trace===''),true);
equal(JSON.stringify(messages).includes('http'),false,'no page URL in visibility event');
TP.setTracingEnabled(false);equal(listeners.size,0);
TP.setTracingEnabled(true);equal(messages.length,4,'reenable records current visibility once');
equal(TP.getVisibilityEpoch(),2);

let clock=0,painted=0,exports=0,taint=false,emptyBlob=false;
const image={naturalWidth:32,naturalHeight:32,src:'fixture'};
const page={normUrl:s=>s,getBestImgUrl:i=>i.src,log:{debug(){},warn(){}}};
const canvasContext={drawImage(){clock+=2;},getImageData(){clock+=3;if(taint)throw new Error('tainted');return {data:new Uint8ClampedArray(32*32*4).fill(255)};},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){clock+=4;painted++;}};
const canvasDoc={createElement(tag){equal(tag,'canvas');return {getContext(){return canvasContext;},toBlob(cb,format){equal(format,'image/webp');clock+=11;exports++;cb(emptyBlob?null:{size:100});}};}};
vm.runInNewContext(source('src/content/erase-canvas.js'),{window:{__TP:page},document:canvasDoc,Image:class{},Uint8ClampedArray,
 performance:{now:()=>clock},URL:{createObjectURL:()=> 'blob:fixture'}});
const boxes={boxes:[{l:0.3,t:0.3,w:0.2,h:0.2,r:0}]};
const erased=await page.buildErasedBackground(image,boxes);
equal(erased.url,'blob:fixture');equal(erased.painted,1);equal(painted,1);equal(exports,1,'metrics add no extra encode');
equal(JSON.parse(JSON.stringify(erased.timing)),{readableSourceMs:5,canvasReadMs:5,erasePaintMs:4,encodeMs:11});
equal(erased.ms,20,'old elapsed metric excludes readable-source probe');
emptyBlob=true;equal(await page.buildErasedBackground(image,boxes),null,'failed encode still refused');
taint=true;equal(await page.buildErasedBackground(image,boxes),null,'taint still refused, no fallback');
equal(await page.buildErasedBackground(image,{}),null,'invalid box contract unchanged');

// Lens typed events cover fetch invocation, headers, body; NOT actual socket timing.
globalThis.chrome={runtime:{getManifest:()=>({version:'fixture'}),lastError:null},storage:{local:{get:async()=>({}),set:async()=>{}}}};
const shipped=[],requests=[];
let mode='ok';
globalThis.fetch=async(url,opts)=>{
 if(String(url).endsWith('/v1/trace')){const body=JSON.parse(opts.body);shipped.push(...body.records);return new Response(JSON.stringify({ok:true,session:body.traceSession}),{status:200});}
 requests.push({url,opts});
 if(mode==='abort')throw new DOMException('cancelled','AbortError');
 return new Response(mode==='bad'?'not JSON':JSON.stringify({schema:'fixture',ok:true}),{status:200,headers:{'content-type':'application/json'}});
};
const trace=await import('../src/shared/trace.js');
const {fetchLensRawViaRest}=await import('../src/background/transports/lens.js');
trace.setTracingEnabled(true,()=> 'http://fixture','compact','test-1921');
const options={imageBytes:new Uint8Array([1,2,3]),mime:'image/jpeg',lang:'th',jobId:'12345678-1234-1234-1234-123456789abc',imageId:'i1',batchId:'aaaaaaaaaaaaaaaa',traceId:'t12345678'};
equal((await fetchLensRawViaRest('http://fixture',options)).ok,true);
mode='bad';await assert.rejects(fetchLensRawViaRest('http://fixture',options));checks++;
mode='abort';await assert.rejects(fetchLensRawViaRest('http://fixture',options));checks++;
await trace.flushTrace();
const events=shipped.filter(r=>r.d?.schema==='tp.audit/1'&&r.d.event==='request_timing'&&r.d.phase==='lens').map(r=>r.d);
equal(events.map(e=>e.reason),['http_started','http_headers','response_complete','http_started','http_headers','body_failed','http_started','cancelled']);
equal(events.every(e=>e.scope.jobId===options.jobId&&e.scope.imageId===options.imageId),true);
equal(requests.length,3,'one fetch per requested generation, no diagnostic retry');
equal(requests.every(r=>r.opts.priority==='low'),true,'transport scheduling was not silently changed');
console.log(`PASS process diagnostics 19.21: ${checks} assertions; real modules, mocked DOM/canvas/HTTP`);
