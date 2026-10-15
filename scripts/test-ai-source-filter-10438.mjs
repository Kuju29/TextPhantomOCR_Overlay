import assert from 'node:assert/strict';
import {hasTranslatableText,translationUnits,applyTranslations} from '../src/shared/lens-document.js';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {createTranslationService} from '../src/background/ai/translation-service.js';
import {checkedOrigins} from '../src/shared/ai/conversation/origins.js';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveConversationJob,finishConversationJob} from '../src/background/ai/translation-paths/order.js';
import {prepareConversationRepairWire} from '../src/background/repair/conversation-repair-wire.js';

const skipped=['A','L','-',' \u200bA\u200d ','A\u0301','\u200b\u200d','...!?','©★→','①②③','12345','我','ก'];
for(const text of skipped)assert.equal(hasTranslatableText(text),false,`Standalone/noise source must not reach AI: ${JSON.stringify(text)}`);
for(const text of ['ดี','มี','ที่','ไป','日本','你好','OK','No','A!','ก1'])assert.equal(hasTranslatableText(text),true,`Meaningful short source must remain: ${text}`);

const texts=['A','L','-','ดี','日本','Hello there'];
const doc={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},
  paragraphs:texts.map((sourceText,i)=>({id:`p${i}`,sourceText,items:[]}))};
const units=translationUnits(doc);
assert.deepEqual(units.map(x=>x.id),['g0','g1','g2','g3','g4','g5'],'Filtering must not renumber the canonical paragraph IDs.');
assert.deepEqual(units.filter(x=>x.translatable).map(x=>x.id),['g3','g4','g5']);
const applied=applyTranslations(doc,units.map(x=>({id:x.id,text:x.translatable?'คำแปล':x.text})));
assert.deepEqual(applied.report.missing,[],'Deliberate filtered units must not become missing repairs.');
assert.equal(applied.document.paragraphs[0].aiText,'A');

{
  const payload={source:'ai',lang:'th',context:{page_url:'source-filter-gap-proof',tp_tab_session:'fixture-owner',page_index:0},
    metadata:{image_id:'gap-page'},ai:{provider:'login',translation_mode:'conversation'}};
  reserveConversationJob(payload,1);
  const dispatched=[];const queue=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),
    dispatch:async(rows,_options,plan)=>{dispatched.push({rows,origins:plan.origins});return {translations:rows.map(x=>({id:x.id,text:'คำแปล'})),meta:{}};}});
  const result=await queue.submit(units.filter(x=>x.translatable),{payload,ai:payload.ai,imageId:'gap-page',targetLang:'th',sourceLang:'en',route:'server'});
  assert.deepEqual(dispatched[0].rows.map(x=>x.id),['I1_P3','I1_P4','I1_P5'],'TranslateAll must preserve the omitted paragraph gaps in the actual Conversation wire.');
  assert.deepEqual(dispatched[0].origins[0].originalIds,['g3','g4','g5']);
  assert.deepEqual(result.missing,[]);assert.deepEqual(result.translations.map(x=>x.id),['g3','g4','g5']);
  finishConversationJob(payload);queue.close();
  const checkpoint={pageId:'gap-page',generationId:'gap-gen',units:units.map(x=>({...x,sourceHash:`hash-${x.id}`})),ai:{conversation:payload.ai.conversation}};
  const row={id:'R0',pageId:'gap-page',unitId:'g5',text:units[5].text,sourceHash:'hash-g5',generationId:'gap-gen'};
  const repair=prepareConversationRepairWire(new Map([['gap-page',checkpoint]]),[row],true);
  assert.deepEqual(repair.wireUnits.map(x=>x.id),['I1_P5'],'Repair must preserve the same source ID used in the initial turn.');
}

for(const translation_mode of ['independent','conversation']){
  let providerCalls=0;const checkpoints=[];
  const result={lensDocument:{...doc,paragraphs:doc.paragraphs.slice(0,3)},eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
  const outcome=await translateLensPage({base:'http://fixture.invalid',payload:{lang:'th',metadata:{image_id:'noise-page'},context:{}},result,
    plan:{route:'server',ai:{provider:'login',translation_mode}},jobId:'noise-job',onCheckpoint:async row=>checkpoints.push(row),
    dependencies:{translateUnits:async()=>{providerCalls++;throw new Error('No provider request is expected.');}}});
  assert.equal(providerCalls,0);assert.equal(outcome.skipped,true);assert.deepEqual(outcome.missing,[]);
  assert.equal(checkpoints[0].reason,'no_translatable_text');assert.equal(checkpoints[0].stage,'skipped');
}

const wire=[{id:'I1_P0',text:'A'},{id:'I2_P1',text:'L'},{id:'I2_P2',text:'-'},{id:'I2_P3',text:'日本'},{id:'I3_P4',text:'ดี'}];
{
  let calls=0;const service=createTranslationService({server:async()=>{calls++;throw new Error('Filtered source reached a provider.');}});
  for(const [id,text] of [['I1_P0','A'],['I2_P1','L'],['I2_P1','-']]){
    const answer=await service([{id,text}],{route:'server',ai:{translation_mode:'conversation'}});
    assert.deepEqual(answer.missing,[]);assert.deepEqual(answer.meta.skippedUnitIds,[id]);
    assert.equal(answer.meta.providerAttempts,0,`The exact <<${id}:${text}>> record must never be dispatched.`);
  }
  assert.equal(calls,0);
}
for(const translation_mode of ['independent','conversation']){
  const dispatched=[];const service=createTranslationService({server:async(rows,options)=>{
    dispatched.push({rows,options});return {translations:rows.map(x=>({id:x.id,text:'คำแปล'})),missing:[],meta:{generationAttempts:1}};
  }});
  const options={route:'server',ai:{translation_mode,prompt:'STYLE_SENTINEL',independent_examples:[{source:'EXAMPLE_SENTINEL'}],
    conversation:{webchatRunId:'RUN_SENTINEL',owner:'OWNER_SENTINEL',documentId:'DOCUMENT_SENTINEL',branch:'initial',
      origins:[{pageId:'page-1',pageOrder:1,unitIds:['I1_P0'],originalIds:['g0']},
        {pageId:'page-2',pageOrder:2,unitIds:['I2_P1','I2_P2','I2_P3'],originalIds:['g1','g2','g3']},
        {pageId:'page-3',pageOrder:3,unitIds:['I3_P4'],originalIds:['g4']}]}}};
  const outcome=await service(wire,options);
  assert.deepEqual(dispatched[0].rows.map(x=>x.id),['I2_P3','I3_P4'],'Actual initial/repair provider dispatch must preserve the supplied IDs.');
  assert.deepEqual(outcome.missing,[]);assert.deepEqual(outcome.meta.skippedUnitIds,['I1_P0','I2_P1','I2_P2']);
  assert.equal(dispatched[0].options.ai.prompt,'STYLE_SENTINEL');
  assert.equal(dispatched[0].options.ai.conversation.webchatRunId,'RUN_SENTINEL');
  assert.equal(dispatched[0].options.ai.conversation.owner,'OWNER_SENTINEL');
  assert.equal(dispatched[0].options.ai.independent_examples[0].source,'EXAMPLE_SENTINEL');
  assert.deepEqual(checkedOrigins(dispatched[0].options.ai.conversation.origins,['I2_P3','I3_P4']).flatMap(x=>x.originalIds),['g3','g4']);
  const empty=await service(wire.slice(0,3),{...options,ai:{...options.ai,conversation:{...options.ai.conversation,origins:options.ai.conversation.origins.slice(0,2).map(x=>({...x,unitIds:x.unitIds.filter(id=>id!=='I2_P3'),originalIds:x.originalIds.filter(id=>id!=='g3')}))}}});
  assert.equal(dispatched.length,1,'An all-filtered request must make no provider call.');
  assert.deepEqual(empty.missing,[]);assert.equal(empty.meta.generationAttempts,0);
}
{
  const dispatched=[];const service=createTranslationService({server:async(rows,options)=>{
    dispatched.push({rows,options});return {translations:[{id:rows[0].id,text:'I'}],missing:[],meta:{generationAttempts:1}};
  }});
  const memory=[{id:'memory',text:'A'}],previous=[{id:'previous',text:'L'}];
  const result=await service([{id:'I2_P3',text:'Hello there'}],{route:'server',ai:{translation_mode:'independent',
    series_state:memory,prev_context:previous,page_context:[{id:'c0',text:'A'},{id:'c1',text:'Nearby sentence'}],
    source_context:[{targetIds:['I2_P3'],origin:'page_checkpoint',units:[{id:'c2',text:'L'},{id:'c3',text:'-'},{id:'c4',text:'Source context'}]}]}});
  assert.deepEqual(dispatched[0].options.ai.page_context.map(x=>x.id),['c1']);
  assert.deepEqual(dispatched[0].options.ai.source_context[0].units.map(x=>x.id),['c4'],'Clean current units must still filter noise from an old checkpoint.');
  assert.deepEqual(dispatched[0].options.ai.source_context[0].targetIds,['I2_P3']);
  assert.equal(dispatched[0].options.ai.series_state,memory);assert.equal(dispatched[0].options.ai.prev_context,previous);
  assert.equal(result.translations[0].text,'I','Source eligibility must never reject a valid single-character translation.');
}
console.log('PASS source noise/singleton filter, Thai/CJK short words, actual TranslateAll/repair stable IDs, deliberate no-text receipts and dispatch/bootstrap preservation.');
