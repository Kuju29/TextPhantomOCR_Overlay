// UI-selected Independent -> workload -> real Local HTTP request -> validated
// checkpoint -> bounded story examples. No live model and no provider retry.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createIndependentExampleStore,verifiedIndependentPairs} from '../src/background/ai/independent-example-store.js';
import {planIndependentExamples} from '../src/background/ai/independent-example-budget.js';
import {boundedIndependentPairs,formatIndependentStoryExamples,humanExampleCount,
  selectIndependentStoryExamples} from '../src/shared/ai/independent/examples.js';
import {buildStyleExamples} from '../src/shared/ai/direct-local/prompt.js';
import {estimateProviderInput} from '../src/shared/ai/workload/budget.js';
import {textWeight} from '../src/shared/ai/workload/model.js';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
import {createTranslationService} from '../src/background/ai/translation-service.js';
import {translateDirectLocal} from '../src/background/ai/transports/direct-local.js';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {makePageCheckpoint} from '../src/background/repair/page-checkpoint.js';
import {BUNDLED_CANONICAL_PROMPT_PLANS} from '../src/generated/canonical-prompt-plans.js';
import '../src/shared/diagnostic-schema.js';

const disk={}, requests=[], diagnostics=[];
let unblockPending=null;
const read=async key=>({[key]:structuredClone(disk[key])});
const write=async patch=>Object.assign(disk,structuredClone(patch));
const examples=createIndependentExampleStore({read,write});
const workload=createWorkloadController({read,write,emit:()=>{}});
const server=http.createServer(async(request,response)=>{
  let raw=''; for await (const part of request) raw+=part;
  const body=JSON.parse(raw);requests.push(body);
  const current=body.messages.at(-1).content;
  assert.equal(body.messages.length,2,'Independent must never send chat history');
  assert.match(current,/<<TP_P0:/);
  assert.equal(body.messages[0].role,'system');
  assert.equal(body.messages[1].role,'user');
  assert(!body.messages.some(message=>JSON.stringify(message).includes('image_url')),
    'prior images are never replayed as examples');
  if (current.includes('<<TP_P0:Pending page source>>'))
    await new Promise(resolve=>{unblockPending=resolve;});
  response.writeHead(200,{'content-type':'application/x-ndjson'});
  response.end(JSON.stringify({model:body.model,message:{role:'assistant',content:'<<TP_P0:สวัสดี>>'},done:false})+'\n'+
    JSON.stringify({model:body.model,done:true,done_reason:'stop',prompt_eval_count:240,eval_count:22,total_duration:1e7})+'\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}`;
const service=createTranslationService({directLocal:(units,options)=>translateDirectLocal(units,
  {...options,canonicalPrompt:BUNDLED_CANONICAL_PROMPT_PLANS.th,
    wireTrace:(event,value)=>diagnostics.push([event,structuredClone(value)])})});
const baseAi={provider:'ollama',model:'fixture',base_url:url,local_adapter:{protocol:'ollama',baseUrl:url},
  prompt:'',translation_mode:'independent',style_examples:true,thinking:'off',
  model_capabilities:{limits:{scope:'runtime',source:'fixture',contextTokens:16384,
    runtimeContextTokens:16384,modelContextTokens:32768,maxOutputTokens:4096},
    reasoning:{supported:false},structuredOutput:{supported:false}}};
async function page(source,series,model='fixture',enabled=true,documentUrl='',exampleStore=examples,
  owner='tab-session-A',batch='batch-A',planner=workload,metadataBatchOnly=false) {
  const imageId=`fixture-${requests.length+1}`;
  const pageUnits=(Array.isArray(source)?source:[source]).map((text,index)=>({
    id:`unit-${requests.length+1}-${index}`,text,translatable:true,paragraphIds:[`p${index}`]}));
  const result={lensDocument:{languages:{source:'en'}},eraseBoxes:[]};
  let checkpoint; const events=[];
  const out=await translateLensPage({base:'http://fixture.invalid',
    payload:{lang:'th',source:'ai',context:{series_key:series,
      tp_tab_session:owner,...(metadataBatchOnly ? {} : {batch_id:batch}),
      page_url:documentUrl || `https://example.invalid/read/${encodeURIComponent(series)}`},
      metadata:{image_id:imageId,...(metadataBatchOnly ? {batch_id:batch} : {})},
      idempotency_key:crypto.randomUUID()},
    result,plan:{route:'direct-local',ai:{...baseAi,model,style_examples:enabled}},
    trace:(name,data)=>events.push([name,data]),
    onCheckpoint:async data=>{
      if(data.stage==='prepared') checkpoint=await makePageCheckpoint({...data,ctx:{jobId:imageId}});
    },dependencies:{workloadController:planner,independentExampleStore:exampleStore,
      refreshLocalAiCapabilities:async ai=>ai,
      requireAiLensDocument:r=>r.lensDocument,translationUnits:()=>pageUnits,
      requireTranslationConservation:()=>({eligibleParagraphCount:pageUnits.length,
        excludedBlankParagraphCount:0,unitCount:pageUnits.length}),
      translateUnits:service,diagnoseTargetScripts:()=>[],summarizeUnitScripts:()=>[],
      applyTranslations:(doc,items)=>({document:{...doc,applied:items},report:{translated:1,missing:[],complete:true}}),
      classifyAiTranslationReport:r=>({usable:true,...r}),
      eraseBoxesForAiPartial:()=>({ok:true,eraseBoxes:[]})}});
  assert.equal(out.complete,true);
  assert.equal(checkpoint.ai.independent_examples,undefined,'no examples copied per page into session storage');
  return {request:requests.at(-1),contract:diagnostics.filter(row=>row[0]==='contractSelection').at(-1)?.[1],checkpoint,events};
}
try {
  const first=await page('Hello from page one','example.invalid/manga/story-A');
  assert.match(first.request.messages.at(-1).content,/H01\nEN:/);
  assert.equal(first.contract.independentExamples.source,'human');
  assert.equal(first.contract.independentExamples.includedPairs,4,
    'the first Local Independent prompt includes four human examples when enabled');
  assert.match(first.request.messages.at(-1).content,/H04\nEN:/);
  assert.doesNotMatch(first.request.messages.at(-1).content,/H05\nEN:/);
  const humanFour=buildStyleExamples('th',[],false,'en',4),humanTwenty=buildStyleExamples('th',[],false,'en',20);
  const [firstSystem,firstUser]=first.request.messages.map(message=>String(message.content || ''));
  assert(firstUser.includes(humanFour));
  const comparisonTwenty=firstUser.replace(humanFour,humanTwenty);
  const fourWireEstimate=estimateProviderInput({system:firstSystem,user:firstUser});
  const twentyWireEstimate=estimateProviderInput({system:firstSystem,user:comparisonTwenty});
  assert(twentyWireEstimate>fourWireEstimate,'20 examples must cost more estimated input on the same request');
  assert.equal(first.contract.independentExamples.evidenceStage,'prompt_composed_before_dispatch');
  assert.match(first.checkpoint.ai.independent_scope.key,/^[a-f0-9]{64}$/);
  const selectedLog=first.events.find(([name,data])=>name==='independentExamples' &&
    data.examplePhase==='selected')?.[1];
  const committedLog=first.events.find(([name,data])=>name==='independentExamples' &&
    data.examplePhase==='after_checkpoint')?.[1];
  assert(selectedLog?.operationId && selectedLog.operationId===committedLog?.operationId,
    'selection and commit logs must correlate by provider request operation ID');
  const second=await page('Next from page two','example.invalid/manga/story-A');
  assert.match(second.request.messages.at(-1).content,/ต้นฉบับ: Hello from page one\n   คำแปล: สวัสดี/);
  assert.doesNotMatch(second.request.messages.at(-1).content,/H01\nEN:/);
  assert.equal(second.contract.independentExamples.source,'story');
  assert.equal(second.contract.independentExamples.includedPairs,1);
  assert.equal(second.contract.promptLayout.independentExamples.exampleChars,
    second.contract.independentExamples.exampleChars);
  const plannedInput = result => result.events.find(([name])=>name==='translationBudget')?.[1]?.planned?.estimatedInput;
  assert(Number.isFinite(plannedInput(first)) && Number.isFinite(plannedInput(second)));
  assert(plannedInput(second)<plannedInput(first),
    'one accepted story pair should cost less estimated input than four human examples');
  const metadataFirst=await page('Meta first accepted','example.invalid/manga/meta-batch',
    'fixture',true,'',examples,'tab-session-meta','batch-meta',workload,true);
  const metadataSecond=await page('Meta second dialogue','example.invalid/manga/meta-batch',
    'fixture',true,'',examples,'tab-session-meta','batch-meta',workload,true);
  assert.equal(metadataFirst.contract.independentExamples.source,'human');
  assert.equal(metadataSecond.contract.independentExamples.source,'story',
    'the metadata-only batch ID must reach Independent scope without copying user context');
  assert(metadataSecond.request.messages.at(-1).content.includes('ต้นฉบับ: Meta first accepted'));
  const missingBatchFirst=await page('No batch first','example.invalid/manga/no-batch',
    'fixture',true,'',examples,'tab-session-meta','',workload,true);
  const missingBatchSecond=await page('No batch second','example.invalid/manga/no-batch',
    'fixture',true,'',examples,'tab-session-meta','',workload,true);
  assert.equal(missingBatchFirst.contract.independentExamples.scopeStatus,'batch_unverified');
  assert.equal(missingBatchSecond.contract.independentExamples.source,'human',
    'no batch in either location must keep previous source and translation out of the request');
  assert(!missingBatchSecond.request.messages.at(-1).content.includes('No batch first'));
  const otherStory=await page('Hello in other story','example.invalid/manga/story-B');
  assert.equal(otherStory.contract.independentExamples.source,'human');
  const otherOwner=await page('Other account, same URL','example.invalid/manga/story-A',
    'fixture',true,'',examples,'tab-session-B','batch-A');
  assert.equal(otherOwner.contract.independentExamples.source,'human',
    'another owner on the same URL must not see A accepted translations');
  assert(!otherOwner.request.messages.at(-1).content.includes('Hello from page one'));
  const anotherRun=await page('New run, same owner and URL','example.invalid/manga/story-A',
    'fixture',true,'',examples,'tab-session-A','batch-B');
  assert.equal(anotherRun.contract.independentExamples.source,'human',
    'a new login/run in one tab must not inherit old accepted source text');
  assert(!anotherRun.request.messages.at(-1).content.includes('Hello from page one'));
  const otherModel=await page('Hello on other model','example.invalid/manga/story-A','fixture-different');
  assert.equal(otherModel.contract.independentExamples.source,'human');
  const noMemoryWhenOff={...examples,
    scope:async()=>{throw new Error('disabled examples must not scope storage');},
    select:async(_scope,_lang,enabled)=>{
      assert.equal(enabled,false);
      return {source:'none',pairs:[],scopeStatus:'disabled',storageStatus:'disabled'};
    },
    append:async()=>{throw new Error('disabled examples must not write accepted pairs');}};
  const off=await page('Hello with option disabled','example.invalid/manga/story-A',
    'fixture',false,'',noMemoryWhenOff);
  assert.equal(off.contract.independentExamples.source,'none');
  assert.equal(off.contract.independentExamples.exampleChars,0);
  const hostOnly=await page('Host-only chapter one','example.invalid','fixture',true,'https://example.invalid/chapter/uuid-1');
  const hostOnlyNext=await page('Host-only chapter two','example.invalid','fixture',true,'https://example.invalid/chapter/uuid-2');
  assert.equal(hostOnly.contract.independentExamples.source,'human');
  assert.equal(hostOnlyNext.contract.independentExamples.source,'human',
    'two chapters on the same host must never share examples without a verified series key');
  assert.equal(hostOnly.checkpoint.ai.independent_scope.scopeStatus,'document');
  const genericOne=await examples.scope(baseAi,{series_key:'example.invalid/t/mangasite',
    page_url:'https://example.invalid/chapter/uuid-1',tp_tab_session:'tab-session-A',batch_id:'batch-A'},'en','th');
  const genericOther=await examples.scope(baseAi,{series_key:'example.invalid/t/mangasite',
    page_url:'https://example.invalid/chapter/uuid-2',tp_tab_session:'tab-session-A',batch_id:'batch-A'},'en','th');
  assert.notEqual(genericOne.key,genericOther.key,'heuristic title does not prove same story');
  const hashStoryA=await examples.scope(baseAi,{page_url:'https://reader.invalid/#/story/A/chapter/1',
    tp_tab_session:'tab-session-A',batch_id:'batch-A'},'en','th');
  const hashStoryB=await examples.scope(baseAi,{page_url:'https://reader.invalid/#/story/B/chapter/1',
    tp_tab_session:'tab-session-A',batch_id:'batch-A'},'en','th');
  assert.notEqual(hashStoryA.key,hashStoryB.key,'SPA hash routes must isolate stories');
  const manga='mangadex.org/title/11111111-2222-3333-4444-555555555555';
  const verifiedOne=await examples.scope(baseAi,{series_key:manga,page_url:'https://mangadex.org/chapter/1',
    tp_tab_session:'tab-session-A',batch_id:'batch-A'},'en','th');
  const verifiedOther=await examples.scope(baseAi,{series_key:manga,page_url:'https://mangadex.org/chapter/2',
    tp_tab_session:'tab-session-A',batch_id:'batch-A'},'en','th');
  assert.equal(verifiedOne.key,verifiedOther.key,'verified manga UUID may share examples across chapters');
  assert.equal(requests.length,13,'each page consumes exactly one request');
  const noOwner=await examples.scope(baseAi,{series_key:manga,page_url:'https://mangadex.org/chapter/1'},'en','th');
  assert.equal(noOwner.scopeStatus,'owner_unverified','unknown owner must not persist historical dialogue');
  const noBatch=await examples.scope(baseAi,{series_key:manga,page_url:'https://mangadex.org/chapter/1',
    tp_tab_session:'tab-session-A'},'en','th');
  assert.equal(noBatch.scopeStatus,'batch_unverified','unknown batch must not use another run\'s history');
  const noOwnerPage=await page('Unowned page','example.invalid/manga/story-A',
    'fixture',true,'',examples,'','batch-A');
  assert.equal(noOwnerPage.contract.independentExamples.source,'human');
  assert.equal(noOwnerPage.contract.independentExamples.scopeStatus,'owner_unverified');
  assert(!noOwnerPage.request.messages.at(-1).content.includes('Hello from page one'));
  const selection=await examples.select(second.checkpoint.ai.independent_scope,'th',true);
  const repair=await service([{id:'repair-unit',text:'Repair the next line'}],{
    ai:{...baseAi,independent_examples:selection,repair_reason:'wrong_target_script'},
    route:'direct-local',targetLang:'th',sourceLang:'en',operationId:`repair:${crypto.randomUUID()}`});
  assert.equal(repair.translations[0].text,'สวัสดี');
  assert.match(requests.at(-1).messages.at(-1).content,/ต้นฉบับ: Hello from page one/);
  assert.equal(diagnostics.filter(row=>row[0]==='contractSelection').at(-1)[1].independentExamples.source,'story');
  assert.equal(requests.length,15,'repair uses one additional request and no Conversation history');
  const beforeFailure=requests.length;
  const brokenStore={...examples,append:async()=>{throw Object.assign(Error('quota'),
    {code:'independent_examples_storage_unavailable'});}};
  const retained=await page('Accepted before quota issue','example.invalid/manga/story-A',
    'fixture',true,'',brokenStore);
  assert.equal(requests.length,beforeFailure+1,'one valid translation must remain one provider request');
  assert.equal(retained.events.filter(([name,data])=>name==='independentExamples' &&
    data.exampleStorage==='write_failed' && data.examplePhase==='after_checkpoint').length,1,
    'failed auxiliary example write must be reported without losing valid translation');
  const compact=globalThis.TPAuditSchema.sanitize(retained.events.find(([name,data])=>
    name==='independentExamples' && data.exampleStorage==='write_failed')[1]);
  assert.equal(compact.event,'independent_examples');
  assert.equal(compact.exampleStorage,'write_failed');
  assert(Number.isFinite(compact.sampleCandidates));
  const fivePairs=[
    {src:'Beta ancient phrase',tgt:'ประโยคเบต้า'},
    {src:'Alpha chapter phrase',tgt:'ประโยคอัลฟ่า'},
    {src:'An unrelated phrase 1',tgt:'ข้อความอื่นหนึ่ง'},
    {src:'An unrelated phrase 2',tgt:'ข้อความอื่นสอง'},
    {src:'An unrelated phrase 3',tgt:'ข้อความอื่นสาม'},
  ];
  const failingFive={...examples,
    select:async()=>({source:'story',pairs:fivePairs,targetLang:'th',
      acceptedPairs:5,scopeStatus:'document',storageStatus:'ready'}),
    append:async()=>{throw Object.assign(new Error('quota'),
      {code:'independent_examples_storage_unavailable'});}};
  const splitPlanner={async open({ai}) {
    const session={key:'0'.repeat(64),ai,
      setIndependentExamples(value){this.ai={...this.ai,independent_examples:value};},
      next(rows,offset){
        const unit=rows[offset];
        return {units:[unit],splitReason:'reliability',
          estimate:{predictedOutput:160,reasoningReserve:0,estimatedInput:1000,
            target:160,recordTarget:1,sourceChars:unit.text.length,fitsHard:true,fitsTarget:true,
            limits:ai.model_capabilities.limits}};
      },
      observe(){return {outcome:'ok',usage:{inputTokens:240,outputTokens:22},learning:{}};},
      async flush(){}};
    return session;
  }};
  const splitStart=requests.length;
  const split=await page(['Alpha chapter phrase now','Beta ancient phrase again'],
    'example.invalid/manga/split','fixture',true,'',failingFive,
    'tab-session-A','batch-A',splitPlanner);
  assert.equal(requests.length-splitStart,2,'two planned chunks use exactly two Local AI requests');
  assert(!requests[splitStart].messages.at(-1).content.includes('ต้นฉบับ: Beta ancient phrase\n'));
  assert(requests[splitStart+1].messages.at(-1).content.includes('ต้นฉบับ: Beta ancient phrase\n'),
    'write failure cannot shrink the next chunk\'s retrieval pool to the previous selection');
  assert(split.events.some(([event,data])=>event==='independentExamples' &&
    data.exampleStorage==='write_failed'));
  const pendingPage=page('Pending page source','example.invalid/manga/story-C');
  const waitStart=Date.now();
  while(!unblockPending && Date.now()-waitStart<2000)
    await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(typeof unblockPending,'function','the mock provider must receive the pending page');
  const whilePending=await page('During pending','example.invalid/manga/story-C');
  assert.equal(whilePending.contract.independentExamples.source,'human',
    'pending translation cannot become an accepted story example');
  unblockPending();
  await pendingPage;
  const afterCommit=await page('Pending page source again','example.invalid/manga/story-C');
  assert.equal(afterCommit.contract.independentExamples.source,'story');
  assert.match(afterCommit.request.messages.at(-1).content,/ต้นฉบับ: Pending page source\n   คำแปล: สวัสดี/);
  assert.deepEqual(verifiedIndependentPairs(
    [{id:'good',text:'Source accepted'},{id:'wrong',text:'Source wrong'},
      {id:'duplicate',text:'Source duplicate'},{id:'ambiguous',text:'Source ambiguous'}],
    {translations:[{id:'good',text:'คำแปล'},{id:'wrong',text:'ENGLISH'},
      {id:'duplicate',text:'A'},{id:'duplicate',text:'B'},
      {id:'ambiguous',text:'คำแปล'}],meta:{alignmentUncertainIds:['ambiguous']}},
    {wrongLanguage:['wrong'],missing:[]}),
    [{src:'Source accepted',tgt:'คำแปล'}],'only accepted, unique aligned rows become story examples');
  const storyPool=boundedIndependentPairs([
    {src:'魔王はまだ生きている',tgt:'ราชาปีศาจยังมีชีวิตอยู่'},
    ...Array.from({length:18},(_,index)=>({src:`unrelated ${index}`,tgt:`ไม่เกี่ยวข้อง ${index}`})),
    {src:'魔王が帰ってきた',tgt:'ราชาปีศาจกลับมาแล้ว'},
  ]);
  const retrieved=selectIndependentStoryExamples({source:'story',pairs:storyPool,targetLang:'th'},
    '魔王は今ここにいる');
  assert(retrieved.pairs.some(pair=>pair.src==='魔王はまだ生きている'),
    'older relevant Japanese source must beat newer unrelated source');
  assert(retrieved.pairs.some(pair=>pair.src==='魔王が帰ってきた'),
    'a newer relevant Japanese source remains eligible');
  assert(retrieved.pairs.length>=1&&retrieved.pairs.length<=4);
  assert(Array.from(formatIndependentStoryExamples(retrieved,'th')).length<=600,
    'selected examples include label overhead in the 600-character budget');
  const relevanceStore={...examples,
    select:async()=>({source:'story',pairs:storyPool,targetLang:'th',scopeStatus:'document',
      storageStatus:'ready',acceptedPairs:storyPool.length}),
    append:async()=>({accepted:0})};
  const matched=await page('魔王は今ここにいる','example.invalid/manga/CJK','fixture',true,'',relevanceStore);
  const matchedUser=String(matched.request.messages.at(-1).content);
  assert(matchedUser.includes('ต้นฉบับ: 魔王はまだ生きている'));
  assert.equal(matched.contract.independentExamples.includedPairs,retrieved.pairs.length,
    'estimator and Local wire use the same selected example count');
  assert.equal(matched.contract.independentExamples.exampleChars,
    Array.from(formatIndependentStoryExamples(retrieved,'th')).length,
    'wire audit counts precisely the examples composed before dispatch');
  assert(!matchedUser.includes('ต้นฉบับ: unrelated 1\n'),
    'unrelated history must not crowd out matching CJK dialogue');
  const relevantBudget={selection:null,
    setIndependentExamples(value){this.selection=value;},
    next(rows,offset){
      if (this.selection.pairs.length>2) throw Object.assign(new Error('too many examples'),
        {code:'ai_workload_budget_insufficient',requestDispatched:false});
      return {units:rows.slice(offset,offset+1),estimate:{fitsHard:true}};
    }};
  const tapered=planIndependentExamples(relevantBudget,[{id:'P0',text:'魔王は今ここにいる'}],0,
    {source:'story',pairs:storyPool,targetLang:'th'});
  assert.equal(tapered.includedExamplePairs,2);
  assert(tapered.selection.pairs.some(pair=>pair.src==='魔王はまだ生きている'),
    'tight budgets must keep older relevant phrases over unrelated recent examples');
  assert(tapered.selection.pairs.some(pair=>pair.src==='魔王が帰ってきた'));
  assert.equal(humanExampleCount({source:'human'}),4);
  assert.equal(humanExampleCount({source:'human',humanExampleCount:12}),12,
    'an explicitly configured count remains authoritative');
  const broken=createIndependentExampleStore({read:async()=>{throw Error('storage failed');}});
  await assert.rejects(broken.select(second.checkpoint.ai.independent_scope,'th',true),
    {code:'independent_examples_storage_unavailable'},'storage failure must be visible before spending tokens');
  console.log(`PASS Independent E2E: 4 human / ${second.contract.independentExamples.includedPairs} accepted story pair; planned input ${plannedInput(first)} -> ${plannedInput(second)}; same-wire input estimate 4=${fourWireEstimate},20=${twentyWireEstimate}; systemChars=${[...firstSystem].length},userChars=${[...firstUser].length},human4Chars=${[...humanFour].length},human20Chars=${[...humanTwenty].length},story1Chars=${second.contract.independentExamples.exampleChars},wireTextWeight=${textWeight(firstSystem)+textWeight(firstUser)}; pending excluded, no history/image replay`);
} finally { unblockPending?.(); server.closeAllConnections?.(); server.close(); }
