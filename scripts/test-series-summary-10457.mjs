import assert from 'node:assert/strict';
import {splitSeriesSummary,withSeriesSummarySchema} from '../src/shared/ai/series-summary.js';
import {decodeTranslations,assertNoDuplicateJsonKeys} from '../src/shared/ai/direct-local/decode.js';
import {composeCanonicalPrompt,composeTranslationUserMessage} from '../src/shared/ai/direct-local/prompt.js';
import {BUNDLED_CANONICAL_PROMPT_PLANS} from '../src/generated/canonical-prompt-plans.js';
const units=[{id:'unit0',text:'Source'}],wireUnits=[{id:'P0',text:'Source'}];
const base='<<TP_P0:คำแปล>>',memo='พระเอกพบกุญแจ';let checks=0;
const markerCases=[
 [base+'\n<<TP_MEMO:'+memo+'>>','accepted',memo],
 [base,'missing',''],
 [base+'\n<<TP_MEMO: >>','invalid',''],
 [base+'\n<<TP_MEMO:first\nsecond>>','invalid',''],
 [base+'\n<<TP_MEMO:'+('x'.repeat(801))+'>>','invalid',''],
 [base+'\n<<TP_MEMO:a>>\n<<TP_MEMO:b>>\n<<TP_MEMO:c>>','invalid',''],
 [base+'\n<<TP_MEMO:unfinished','invalid',''],
 ['<<TP_MEMO:before '+base+' after>>','invalid',''],
];
for(const [raw,status,summary] of markerCases){const r=splitSeriesSummary(raw,{enabled:true});assert.equal(r.status,status);assert.equal(r.summary,summary);const decoded=decodeTranslations(r.text,units,{compactMarkers:true,wireUnits,allowCompleteMarkersWithoutEnd:true});assert.equal(decoded.translations[0].text,'คำแปล');checks++;}
for(const raw of [base+' prose\n<<TP_MEMO:'+memo+'>>',base+'\n<<TP_MEMO_EXTRA:bad>>',base+'\n<<TP_MEMO:bad <<TP_P99:unknown>> text>>']){const r=splitSeriesSummary(raw,{enabled:true});const d=decodeTranslations(r.text,units,{compactMarkers:true,wireUnits,allowCompleteMarkersWithoutEnd:true});assert(d.diagnostics?.unexpectedProseChars || d.diagnostics?.ignoredUnknownIds?.length || d.diagnostics?.malformedMarkerIds?.length);checks++;}
for(const [raw,status] of [['{"P0":"คำแปล","TP_MEMO":"'+memo+'"}','accepted'],['{"P0":"คำแปล","TP_MEMO":"a","TP_MEMO":"b"}','invalid'],['{"P0":"คำแปล","TP_MEMO":[]}','invalid'],['{"P0":"คำแปล"}','missing']]){const r=splitSeriesSummary(raw,{enabled:true,nativeSchema:true});assert.equal(r.status,status);assert.equal(decodeTranslations(r.text,units,{structured:true,wireUnits}).translations[0].text,'คำแปล');checks++;}
const duplicate=splitSeriesSummary('{"P0":"one","P0":"two","TP_MEMO":"memo"}',{enabled:true,nativeSchema:true});assert.throws(()=>assertNoDuplicateJsonKeys(duplicate.text));checks++;
assert.equal(splitSeriesSummary(base+'\n<<TP_MEMO:'+memo+'>>').text,base+'\n<<TP_MEMO:'+memo+'>>');checks++;
const schema={type:'object',properties:{P0:{type:'string'}},required:['P0'],additionalProperties:false};const before=JSON.stringify(schema);assert.equal(withSeriesSummarySchema(schema).properties.TP_MEMO.maxLength,800);assert.equal(JSON.stringify(schema),before);checks++;
for(const mode of ['off','terms','full']){const prompt=composeCanonicalPrompt(BUNDLED_CANONICAL_PROMPT_PLANS.th,{memory_mode:mode,prompt:''},false,false,'th');const user=composeTranslationUserMessage({sections:prompt.sections,sourceRecords:'<<TP_P0:Source>>',targetLang:'th'});assert.equal(user.includes('TP_MEMO'),mode==='full');checks++;}
let disk={};globalThis.chrome={runtime:{lastError:null,getManifest:()=>({version:'2026.10.4.57'})},storage:{local:{get(keys,callback){callback(Object.fromEntries(keys.map(k=>[k,structuredClone(disk[k])])));},set(patch,callback){Object.assign(disk,structuredClone(patch));callback();}}}};
const {getSeriesMemory,accumulateSeriesMemory,clearSeriesMemory}=await import('../src/background/series-memory.js');
const key='reader.test/manga/alpha',one='https://reader.test/manga/alpha/chapter-1',two='https://reader.test/manga/alpha/chapter-2';
const result=(text,index)=>({Ai:{meta:{pageIndex:index,seriesSummaryRecords:[{text,sourceIds:['P0']}]}}});
assert.equal((await getSeriesMemory(key,'th',one)).state,'');
await accumulateSeriesMemory(key,result('เหตุการณ์ท้ายตอน',2),'th',one);
await accumulateSeriesMemory(key,result('เหตุการณ์ต้นตอน',0),'th',one);
await accumulateSeriesMemory(key,result('เหตุการณ์ต้นตอน',0),'th',one); // Receipt replay replaces its source key.
assert.equal((await getSeriesMemory(key,'th',one)).state,'');
assert.equal((await getSeriesMemory(key,'th',two)).state,'เหตุการณ์ต้นตอน\nเหตุการณ์ท้ายตอน');
assert.equal((await getSeriesMemory(key,'en',two)).state,'');
assert.equal((await getSeriesMemory('reader.test/manga/beta','th',two)).state,'');
await accumulateSeriesMemory(key,result('สรุปตอนสอง',0),'th',two);
assert(!(await getSeriesMemory(key,'th',two)).state.includes('สรุปตอนสอง'));
assert.equal((await getSeriesMemory(key,'th',one)).state,'');
await accumulateSeriesMemory('reader.test',result('POISON',0),'th',one);
assert.equal((await getSeriesMemory('reader.test','th',two)).state,'');
await clearSeriesMemory(key,'th');assert.equal((await getSeriesMemory(key,'th',two)).state,'');checks+=9;

// A new reservation changes wire order, but receipt/retranslation provenance
// for the same chapter page remains stable. Unknown pages cannot teach memory.
const {createReadyQueue}=await import('../src/background/ai/translation-paths/ready-queue.js');
const {reserveConversationJob,finishConversationJob}=await import('../src/background/ai/translation-paths/order.js');
const wireIds=[];
const queue=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:async rows=>{
  wireIds.push(rows.map(r=>r.id));return {translations:rows.map(r=>({id:r.id,text:'คำแปล'})),meta:{seriesSummaryRecords:[{text:'เหตุการณ์',sourceIds:rows.map(r=>r.id)}]}};
}});
function queuePage(index){const payload={source:'ai',lang:'th',context:{page_url:one,tp_tab_session:'summary-owner',...(index===undefined?{}:{page_index:index})},metadata:{image_id:'summary-'+index},ai:{provider:'ollama',model:'fixture',translation_mode:'conversation',memory_mode:'full'}};reserveConversationJob(payload,1);return {payload,ai:payload.ai,imageId:payload.metadata.image_id,targetLang:'th',sourceLang:'en',route:'direct-local'};}
let summaries=[];
for(let attempt=0;attempt<2;attempt++){const options=queuePage(3);const answer=await queue.submit([{id:'g2',text:'Source two'},{id:'g6',text:'Source six'}],options);finishConversationJob(options.payload);summaries.push(answer.meta.seriesSummaryRecords);}
assert.notDeepEqual(wireIds[0],wireIds[1]);
assert.deepEqual(summaries[0][0].sourceIds,['I3_P2','I3_P6']);assert.deepEqual(summaries[0],summaries[1]);checks+=3;
const a=queuePage(4),b=queuePage(5);const [ar,br]=await Promise.all([queue.submit([{id:'g1',text:'Page four'}],a),queue.submit([{id:'g7',text:'Page five'}],b)]);
assert.deepEqual(ar.meta.seriesSummaryRecords[0].sourceIds,['I4_P1','I5_P7']);assert.equal(br.meta.seriesSummaryRecords.length,0);checks+=2;
finishConversationJob(a.payload);finishConversationJob(b.payload);
const unknown=queuePage(undefined);assert.equal((await queue.submit([{id:'g2',text:'Unknown page'}],unknown)).meta.seriesSummaryRecords.length,0);finishConversationJob(unknown.payload);queue.close();checks++;
const unknownKey='reader.test/manga/unknown-pages';await getSeriesMemory(unknownKey,'th',one);
// .72 owner rule: a single translation (no page index) is kept after the chapter's last page.
await accumulateSeriesMemory(unknownKey,result('Single image memo',null),'th',one);assert.equal((await getSeriesMemory(unknownKey,'th',two)).state,'Single image memo');checks++;

console.log(JSON.stringify({suite:'series-summary-10457',checks,passed:true}));
