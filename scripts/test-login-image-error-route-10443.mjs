import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {translateViaServer} from '../src/background/ai/transports/server.js';
import {aiPageFailure} from '../src/background/pipeline/result-policy.js';
const root=path.resolve(fileURLToPath(new URL('../src/',import.meta.url)));
const original='https://fixture.invalid/page.jpg',messages=[],badges=[];
const element=(tag='div')=>({tagName:tag.toUpperCase(),dataset:{},style:{setProperty(k,v){this[k]=v;}},isConnected:false,setAttribute(k,v){this[k]=String(v);},removeAttribute(k){delete this[k];},addEventListener(){},remove(){this.isConnected=false;const i=badges.indexOf(this);if(i>=0)badges.splice(i,1);},getBoundingClientRect:()=>({left:12,top:18,width:300,height:500})});
const image=element('img');image.src=image.currentSrc=original;image.isConnected=true;
const document={images:[image],documentElement:{},body:{appendChild(node){node.isConnected=true;badges.push(node);}},addEventListener(){},createElement:element,querySelectorAll:selector=>selector==='[data-tp-image-error="1"]'?badges:[],getElementById:()=>null};
const TP={bail:false,normUrl:x=>String(x||''),imageIdentity:x=>String(x||''),getBestImgUrl:img=>img.currentSrc||img.src,truncate:x=>String(x||''),log:{info(){},debug(){},warn(){}},clearToasts(){},clearImageStatuses(){},isMangaDexHost:()=>false,mdKeyFromUrl:()=>'',emitViewerEvent(){},showToast(){},getSettings:async()=>({mode:'lens_text',lang:'th'}),dataUriToBlobUrl:async()=>null};
let settings={},requestMode='model-denied',enqueued=0,captureGeneration=true;
let loginPreflightCalls=0,preflightPaths=[];
let contentListener;
const chrome={runtime:{lastError:null,onMessage:{addListener:fn=>contentListener=fn}},storage:{local:{get:(_k,fn)=>fn(structuredClone(settings)),set:(p,fn)=>{Object.assign(settings,p);fn?.();}},session:{get:(_k,fn)=>fn({})}},tabs:{sendMessage(_tab,msg,_opts,callback){messages.push(msg);if(msg.type==='GET_IMAGE_ERROR_TARGET'&&!captureGeneration){callback({ok:false});return;}contentListener(msg,{},callback);}}};
const context=vm.createContext({window:{__TP:TP,scrollX:0,scrollY:0},document,chrome,console:{info(){},log(){},warn(){},error(){},debug(){}},Date,Math,Map,Set,WeakMap,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,AbortSignal,Response,Headers,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,queueMicrotask,fetch:async url=>{
  preflightPaths.push(new URL(String(url)).pathname);
  if(String(url).endsWith('/meta'))return new Response(JSON.stringify({ok:true,paid:{available:true}}),{status:200});
  if(String(url).endsWith('/paid/me'))return new Response(JSON.stringify({email:'fixture@example.test',credits:{available:'100'},models:[{id:'tp-model'}],addons:{entitlements:[{code:'ai_login',status:'active'}]},...(requestMode==='paid-paused'?{paid_paused:true}:{})}),{status:200});
  if(String(url).includes('/login/providers/')){loginPreflightCalls++;if(requestMode==='model-denied-navigate')TP.resetPageInstance('fixture-navigation-during-preflight');return new Response(JSON.stringify({error:{code:'login_model_access_denied',message:'Synthetic account has no access to this Login model.'}}),{status:403});}
  throw new Error('Unexpected fixture network path');
}});
for(const file of ['content/image-finder.js','content/target-key.js','content/overlay/message-controller.js','content/messaging.js'])vm.runInContext(await readFile(path.join(root,file),'utf8'),context,{filename:file});
const noop=()=>{},stubs={
 'background/jobs/lifecycle.js':{restoreSettingsEpoch:async()=>{},getSettingsEpoch:()=>0},
 'background/tab-sessions.js':{restoreTabSessions:async()=>{},ensureTabSession:()=> 'fixture-tab',getTabSessionId:()=> 'fixture-tab'},
 'background/repair/coordinator.js':{repairCoordinator:{registerBatch:async()=>{}}},
 'shared/settings.js':{readFullSettings:async()=>structuredClone(settings)},
 'background/api.js':{getApiBase:async()=> 'http://localhost:7860'},
 'background/series-memory.js':{getSeriesMemory:async()=>({}),selectPromptMemory:()=>({})},
 'background/batches.js':{ensureBatch:()=>({items:new Map()}),batchUpdateToast:noop,batchStopKeepAlive:async()=>{},registerBatchPayload:noop},
 'background/images.js':{fetchImageDataUriFromTab:async()=>null},
 'background/job-queue.js':{describeLimits:()=>({})},
 'background/job-keys.js':{imageKeyFromPayload:()=> 'fixture-image'},
 'background/jobs.js':{enqueue:()=>enqueued++,setCurrentBatchId:noop},
 'background/local-ai-preflight.js':{ensureLocalAiBatchReady:async()=>{throw new Error('Unexpected Local preflight');}},
 'background/image-scan-diagnostics.js':{startImageScanDiagnostics:noop,reportImageScan:async()=>{}},
};
const modules=new Map();
async function moduleAt(file){if(modules.has(file))return modules.get(file);const relative=path.relative(root,file).replaceAll('\\','/');let module;if(stubs[relative]){const exports=stubs[relative];module=new vm.SyntheticModule(Object.keys(exports),function(){for(const[key,value]of Object.entries(exports))this.setExport(key,value);},{context,identifier:file});}else module=new vm.SourceTextModule(await readFile(relative==='background/context-menu.js'&&process.env.TP_CONTEXT_MENU_BASELINE||file,'utf8'),{context,identifier:file});modules.set(file,module);return module;}
const menu=await moduleAt(path.join(root,'background/context-menu.js'));await menu.link((name,from)=>moduleAt(path.resolve(path.dirname(from.identifier),name)));await menu.evaluate();
const run=async({source='login',mode='model-denied',capture=true}={})=>{
 TP.clearImageError(image);messages.length=0;requestMode=mode;captureGeneration=capture;
 settings={mode:'lens_text',sources:'ai',lang:'th',aiServiceMode:'paid',paidTranslationSource:source,paidSessionToken:'synthetic-customer',paidApiBase:'http://localhost:7860',customApiUrl:'http://localhost:7860',apiUrlDefault:'http://localhost:7860',apiUrlReset:'http://localhost:7860',apiDefaultsFetchedAt:Date.now(),paidModel:'tp-model',loginProvider:'login_gemini',loginSessionId:'lgs_'+'a'.repeat(48),loginModel:'web-default'};
 await menu.namespace.onContextMenuClicked({menuItemId:'img_one',srcUrl:original,frameId:0},{id:41,url:'https://fixture.invalid/chapter',title:'Fixture'});for(let n=0;n<20;n++)await new Promise(r=>setImmediate(r));
 return{messages:[...messages],badges:[...badges]};
};
const login=await run();
assert.equal(loginPreflightCalls,1,'The production Login account-model admission path must be reached before the assertion: '+JSON.stringify({preflightPaths,error:login.messages.find(x=>x.type==='IMAGE_ERROR')?.error?.code}));
assert.equal(enqueued,0,'Rejected Login preflight must not enqueue OCR or generation.');
assert.equal(login.messages.filter(x=>x.type==='IMAGE_ERROR').length,1,'Actual Login preflight failure must reach the same IMAGE_ERROR route as job failures.');
assert.equal(login.badges.length,1,'Actual Login preflight must produce a visible image corner badge.');
assert.match(login.badges[0].textContent,/login_model_access_denied/);
assert.equal(login.badges[0].style.left,'16px');assert.equal(login.badges[0].style.top,'22px');
const paid=await run({source:'tp',mode:'paid-paused'});assert.equal(paid.badges.length,1);assert.match(paid.badges[0].textContent,/PAID_PAUSED/);
const unowned=await run({capture:false,mode:'model-denied-navigate'});assert.equal(unowned.messages.filter(x=>x.type==='IMAGE_ERROR').length,0,'A failed initial identity capture must not publish a legacy unpinned error into a later document.');assert.equal(unowned.badges.length,0);assert(unowned.messages.some(x=>x.type==='TP_TOAST'),'The existing preflight error toast remains available when an image badge cannot be owned.');
const navigated=await run({mode:'model-denied-navigate'});assert.equal(navigated.messages.filter(x=>x.type==='IMAGE_ERROR').length,1);assert.equal(navigated.badges.length,0,'A captured old document generation is rejected by the actual content consumer after navigation.');
const delivery=await moduleAt(path.join(root,'background/jobs/result-delivery.js'));await delivery.link((name,from)=>moduleAt(path.resolve(path.dirname(from.identifier),name)));await delivery.evaluate();
const errorModule=await moduleAt(path.join(root,'background/error-message.js'));if(errorModule.status==='unlinked')await errorModule.link((name,from)=>moduleAt(path.resolve(path.dirname(from.identifier),name)));await errorModule.evaluate();
const generation=TP.generationFor(image),job={imgUrl:original,tabId:41,frameId:0,sessionId:'fixture-tab',generation,ai:{provider:'login'},aiGenerationAttempted:true};
const pending=new Map([['fixture-job',job]]);
const actualDelivery=delivery.namespace.createResultDelivery({pendingByJob:pending,findContext:id=>pending.get(id),getTabSessionId:()=> 'fixture-tab',getSettingsEpoch:()=>0,classifyJobError:()=>({permanent:true}),imageErrorMessage:errorModule.namespace.imageErrorMessage,sendToTab:(_tab,msg)=>{messages.push(msg);void TP.applyInsertMessage(msg);},removeJob:id=>pending.delete(id),log:{warn:noop},traceNote:noop,accountingQueue:{enqueue:async()=>{},flush:async()=>{},describe:()=>({})}});
TP.clearImageError(image);actualDelivery.handleJobError('fixture-job',{code:'login_endpoint_native_preparation_required',message:'Browser proof required',stage:'ai'});for(let n=0;n<20;n++)await new Promise(r=>setImmediate(r));
assert.equal(badges.length,1,'Actual Login process failure must paint the owning image error.');assert.match(badges[0].textContent,/login_endpoint_native_preparation_required/);
// Replay the actual .42 failure shape through the production HTTP transport,
// page validation and job error consumer. These are synthetic HTTP responses,
// not a live Login provider call or a re-created upstream SSE transport.
const savedFetch=globalThis.fetch;let generationCalls=0;const sourceDoc=text=>({schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs:[{id:'p0',sourceText:text,items:[]}]});
try{
 globalThis.fetch=async(_url,options)=>{generationCalls++;const request=JSON.parse(options.body);assert.equal(request.provider.id,'login');assert.equal(request.repair.enabled,false);const body={schema:'tp.ai.result/1',translations:[],missing:request.units.map(x=>x.id),meta:{generationAttempts:1,providerTerminalComplete:true}};return new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body})+'\n',{status:200,headers:{'Content-Type':'application/x-ndjson'}});};
 const translate=text=>translateLensPage({base:'http://fixture.invalid',payload:{lang:'th',metadata:{image_id:'zero-marker-page'},context:{}},result:{lensDocument:sourceDoc(text),eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},plan:{route:'server',ai:{provider:'login',model:'login_gemini/web-default',api_key:'synthetic-session',translation_mode:'conversation',memory_mode:'off'}},jobId:'zero-marker-job',conversationSubmit:(units,options)=>translateViaServer(units,{...options,capabilities:{aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'}})});
 const outcome=await translate('Hello there');assert.equal(outcome.usable,false);assert.equal(aiPageFailure(outcome).code,'AI_OUTPUT_INVALID');assert.equal(generationCalls,1,'A malformed Login result must not trigger a hidden second generation.');
 TP.clearImageError(image);pending.set('zero-marker-job',{...job,generation:TP.generationFor(image)});actualDelivery.handleJobError('zero-marker-job',{...aiPageFailure(outcome),message:outcome.reason});for(let n=0;n<20;n++)await new Promise(r=>setImmediate(r));
 assert.equal(badges.length,1,'HTTP200 with zero accepted markers must show the owning image error when there is no active repair owner.');assert.match(badges[0].textContent,/AI_OUTPUT_INVALID/);
 TP.clearImageError(image);const skipped=await translate('A');assert.equal(skipped.skipped,true);assert.deepEqual(skipped.missing,[]);assert.equal(generationCalls,1,'Deliberate singleton/no-text skip must never request the provider.');assert.equal(badges.length,0);
}finally{globalThis.fetch=savedFetch;}
TP.clearImageError(image);TP.resetPageInstance('navigation');await TP.applyInsertMessage({type:'IMAGE_ERROR',original,generation,error:{schema:'tp.error/1',code:'LOGIN_SESSION_REQUIRED',userMessage:'Old Login error'}});assert.equal(badges.length,0,'Late old Login errors must remain suppressed.');
const recycledGeneration=TP.generationFor(image);image.src=image.currentSrc='https://fixture.invalid/recycled.jpg';const latestGeneration=TP.generationFor(image);assert.notEqual(latestGeneration.targetRevision,recycledGeneration.targetRevision);await TP.applyInsertMessage({type:'IMAGE_ERROR',original:image.src,generation:recycledGeneration,error:{schema:'tp.error/1',code:'AI_OUTPUT_INVALID',userMessage:'Old image failure'}});assert.equal(badges.length,0,'A new source generation on the same IMG must refuse the older image error.');
console.log(JSON.stringify({passed:true,scope:'Actual context-menu + Paid/Login preflight + HTTP200 response/page validation + result-delivery + image-finder/target-key/message-controller',modules:modules.size,providerCalls:generationCalls,generationEnqueued:enqueued}));
