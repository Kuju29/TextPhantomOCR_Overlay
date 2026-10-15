// .70 owner rule (Manual, Paid, Login): a job runs on the settings saved when it
// started. Changing settings while it runs affects NEW jobs only: the running
// batch is not cancelled, its repair continues and its results are delivered.
// Only Cancel and reload/navigation (a new tab session) stop work.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const {translationSettingsChanged}=await import(pathToFileURL(root+'/src/background/translation-settings.js'));
const {createResultDelivery,createResultAccountingQueue}=await import(pathToFileURL(root+'/src/background/jobs/result-delivery.js'));

// A. The production storage listener (exact source of background/index.js).
const source=readFileSync(root+'/src/background/index.js','utf8');
const begin=source.indexOf('let translationServiceMode;');
const end=source.indexOf('  else invalidate();',begin)+'  else invalidate();'.length;
assert(begin>=0&&end>begin);
const code=source.slice(begin,end)+'\n});';
function harness(saved){let listener,bumped=0,cancelled=0;
  vm.runInNewContext(code,{getStorage:async()=>saved,chrome:{storage:{onChanged:{addListener:fn=>listener=fn}}},
    translationSettingsChanged,bumpSettingsEpoch:()=>bumped++,traceNote:()=>{},
    repairCoordinator:{cancelSettings:()=>cancelled++,cancelBatch:()=>cancelled++}});
  const settle=()=>new Promise(r=>setTimeout(r,5));
  return {change:async(c,area='local')=>{listener(c,area);await settle();},settle,counters:()=>({bumped,cancelled})};}
let checks=0;
const cases=[
  ['Manual model', {aiServiceMode:'manual'}, {aiModel:{oldValue:'a',newValue:'b'}}],
  ['Manual target language', {aiServiceMode:'manual'}, {lang:{oldValue:'th',newValue:'ja'}}],
  ['Manual thinking/memory profile', {aiServiceMode:'manual'}, {aiProfilesV1:{
    oldValue:{active:{providerIdentity:'p',model:'m'},providers:{p:{models:{m:{profile:{thinking:'off'}}}}}},
    newValue:{active:{providerIdentity:'p',model:'m'},providers:{p:{models:{m:{profile:{thinking:'high',memoryMode:'full'}}}}}}}}],
  ['Paid model', {aiServiceMode:'paid'}, {paidModel:{oldValue:'x/one',newValue:'x/two'}}],
  ['Paid profile', {aiServiceMode:'paid'}, {paidAiProfilesV1:{oldValue:{a:1},newValue:{a:2}}}],
  ['Paid account switch', {aiServiceMode:'paid'}, {paidSessionToken:{oldValue:'a'.repeat(64),newValue:'b'.repeat(64)}}],
  ['Login provider/model', {aiServiceMode:'paid',paidTranslationSource:'login'}, {loginModel:{oldValue:'web-default',newValue:'other'}}],
];
for(const [name,saved,change] of cases){
  const h=harness(saved);await h.settle();await h.change(change);
  assert.deepEqual(h.counters(),{bumped:1,cancelled:0},name);checks++;
}
{ // Login session handle changed (session area), e.g. reconnect in another window.
  const h=harness({aiServiceMode:'paid',paidTranslationSource:'login'});await h.settle();
  await h.change({loginSessionId:{oldValue:'lgs_'+'a'.repeat(48),newValue:'lgs_'+'b'.repeat(48)}},'session');
  assert.deepEqual(h.counters(),{bumped:1,cancelled:0},'Login session change');checks++;
}

// B. Result delivery: a settings change between start and result still delivers;
// a reload/navigation (new tab session) still discards.
function delivery({epochNow,sessionNow}){
  const ctx={idempotencyKey:'op',settingsEpoch:3,tabId:9,frameId:0,imgUrl:'https://image.test/a.jpg',mode:'lens_text',
    source:'ai',sessionId:'tab-session-1',metadata:{image_id:'img-a'}};
  let inserts=0,removed=0;
  const queue=createResultAccountingQueue({persist:async()=>{}});
  const instance=createResultDelivery({accountingQueue:queue,pendingByJob:new Map([['job',ctx]]),findContext:()=>ctx,
    getTabSessionId:()=>sessionNow,getSettingsEpoch:()=>epochNow,getBatch:()=>null,ensureBatch:()=>null,
    removeJob:()=>{removed++},finalizeBatch:()=>{},traceNote:()=>{},log:{warn:()=>{}},
    summarizeResultPresentation:()=>({newImg:null,hasHtml:true,skipReason:'',shouldShowSkipBadge:false}),
    enqueueDomInsert:async()=>{inserts++;return {ok:true,applied:true}},resolveSeriesKey:async()=>'',
    accumulateSeriesMemory:async()=>{},mdCacheKey:()=>'',mdKeyFromUrl:x=>x,normImgSrc:x=>x,
    setCachedDataUri:()=>{},setCachedResult:()=>{},stripImageFields:x=>x,markImagePhase:()=>{},batchUpdateToast:()=>{},
    classifyJobError:()=>({permanent:false}),evaluateTextNoOverlaySkippable:()=>false,imageErrorMessage:()=>({}),
    markDomainNeedsDataUri:()=>{},workflow:{renderReady:async()=>{},applyRequested:async()=>{},applied:async()=>{},failed:async()=>{}}});
  return {run:async()=>{await instance.handleResult('job',{Ai:{meta:{}}});await queue.flush();return {inserts,removed};}};
}
assert.deepEqual(await delivery({epochNow:4,sessionNow:'tab-session-1'}).run(),{inserts:1,removed:1},
  'settings changed while running: the result is still inserted');checks++;
assert.deepEqual(await delivery({epochNow:3,sessionNow:'tab-session-2'}).run(),{inserts:0,removed:1},
  'reload/navigation: the old result is discarded');checks++;
console.log(`PASS ${checks} mid-run settings checks: Manual/Paid/Login changes apply to new jobs only; running work continues; reload still stops it`);
