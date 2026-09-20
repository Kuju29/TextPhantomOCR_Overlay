"""Ready-data cross-page integration, synthetic provider replies, real core paths."""
from contextlib import closing
from pathlib import Path
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import unittest,sys,os,tempfile,threading,json,hashlib
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai import markers,wire_trace,accounting
from backend.ai.clients.base import ChatResult
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.translation_paths.mode import descriptor
from backend.ai.translation_paths import ready_batch
from backend.ai.translation_paths.batch_policy import select_rows
from backend.ai.translation_paths.origins import checked_origins,branch_history
from backend.ai.translation_paths.store import Store
from backend.ai.provider_registry import provider_registry
from backend.ai.providers.openai_provider_runtime import build_messages
from backend.diagnostic_schema import sanitize_conversation_batch,sanitize_conversation

class ReadyTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  p=patch.dict(os.environ,{'TP_CONVERSATION_STATE_FILE':self.temp.name+'/c.db','TP_USAGE_STATE_FILE':self.temp.name+'/u.db',
    'TP_AI_WIRE_TRACE':'1','TP_AI_WIRE_TRACE_DIR':self.temp.name+'/wire'});p.start();self.addCleanup(p.stop)
  p=patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{}));p.start();self.addCleanup(p.stop)
  with accounting._schema_lock:
   accounting._receipt_cache.clear();accounting._receipt_bytes=0
  self.seen=[];self.block=threading.Event();self.release=threading.Event();self.hold=False;self.bad=False
  self.answer_override=None;self.malformed_word=''
  def generate(r):
   # Synthetic dispatch hook for receipt ownership tests, not live network proof.
   from backend.ai import accounting
   accounting.mark_dispatched()
   wire_trace.provider_request(url="https://fixture.invalid/chat",headers={"Authorization":"Bearer PRIVATE_KEY"},payload={"messages":build_messages(r)})
   self.seen.append(r)
   if self.hold and 'Seed' in r.user_parts[-1]:self.block.set();self.release.wait(3)
   ids=list(r.expected_ids) or [f'P{i}' for i in range(r.unit_count)]
   def record(item,value): return f'<<{item}:{value}>>' if item.startswith('I') else f'<<TP_{item}:{value}>>'
   if self.malformed_word and self.malformed_word in r.user_parts[-1]: text='no markers'
   elif callable(self.answer_override): text=self.answer_override(ids,record)
   elif self.answer_override is not None: text=self.answer_override
   else: text='\r\n'.join(record(item,"ผิดภาษา日本語" if self.bad and i==0 else "คำแปล"+str(i)) for i,item in enumerate(ids))+'\n'
   return ChatResult(text=text,used_model=r.model,input_tokens=1000,output_tokens=20*r.unit_count,
    total_tokens=1000+20*r.unit_count,thinking_tokens=0,finish_reason='stop',terminal_completed=True,
    terminal_evidence='provider_done',cached_input_tokens=0)
  p=patch.object(provider_registry.require('huggingface').adapter,'generate',side_effect=generate);p.start();self.addCleanup(p.stop)
  self.addCleanup(self.release.set)
  self.doc=self.temp.name
 def ai(self,index,owner='owner'):
  return AiConfig(api_key='PRIVATE_KEY',user_key=True,provider='huggingface',model='fixture',base_url='https://router.huggingface.co/v1',
   translation_mode='conversation',source_lang='en',memory_mode='off',thinking='off',
   conversation=descriptor({'documentId':self.doc,'pageId':f'page{index}','pageIndex':index},context={'tp_tab_session':owner}),
   model_capabilities={'structured_output':{'supported':False},'limits':{'contextTokens':65536,'maxOutputTokens':8192}})
 def call(self,ai,texts):return ready_batch.translate_ready(texts,'th',ai,admission_identity=ai.conversation['owner'],cancel_check=lambda:False)
 def test_optional_page_indices_have_total_order(self):
  from backend.ai.translation_paths.ready_registry import ReadyRegistry
  registry=ReadyRegistry(None,None,None,None)
  tickets=[]
  for index in [5,None,0,2,-1,1.5,10000000]:
   ai=self.ai(0)
   ai.conversation['pageIndex']=index
   tickets.append(registry.reserve(ai,'th'))
  self.assertEqual([t.order for t in registry._ordered(tickets[0].group)],[3,2,4,1,5,6,7])

 def test_multiline_preserved_and_appended(self):
  a=self.ai(1);x=self.call(a,['Hello','Thanks']);y=self.call(self.ai(2),['Welcome'])
  self.assertEqual(y['meta']['conversation']['historyTurns'],1)
  self.assertEqual(x['meta']['conversation']['formattingWhitespaceChars'],3)
  self.assertEqual(self.seen[-1].history_messages[1]['text'],'<<I1_P0:คำแปล0>>\r\n<<I1_P1:คำแปล1>>\n')
  self.assertEqual(x['meta']['conversation']['unexpectedProseChars'],0)
 def test_prose_is_not_committed_and_bad_language_uses_repair_without_chain_retry(self):
  # Prose makes the transcript structurally ambiguous. Preserve the usable page
  # record, but do not commit it to Conversation and never retry the whole anchor.
  self.answer_override=lambda ids,record:'Here is the answer:\n'+record(ids[0],'คำแปล')
  before=len(self.seen)
  r=self.call(self.ai(1),['Hello'])
  self.assertEqual(len(self.seen)-before,1)
  self.assertEqual(r['meta']['conversation']['commitStatus'],'not_committed_invalid_output')
  self.assertEqual(r['meta']['conversation']['historyTurns'],0)
  # A marker-valid wrong-language answer is structurally safe history. Page
  # validation still rejects the unit, so the page enters repair rather than
  # killing/retrying the Conversation chain.
  self.answer_override=None;self.bad=True;before=len(self.seen)
  with self.assertRaises(__import__('backend.ai.errors',fromlist=['ModelOutputContractError']).ModelOutputContractError):self.call(self.ai(2),['Hello'])
  self.assertEqual(len(self.seen)-before,1)
  self.bad=False;r=self.call(self.ai(3),['Hello'])
  self.assertEqual(r['meta']['conversation']['historyTurns'],1)
 def test_ready_pages_combine_mapping_and_receipt_once(self):
  configs=[self.ai(i) for i in range(4)]
  tickets=[ready_batch.reserve(a,'th') for a in configs]
  self.hold=True
  with ThreadPoolExecutor(4) as pool:
   first=pool.submit(self.call,configs[0],['Seed one','Seed two'])
   self.assertTrue(self.block.wait(2))
   # Put sources into readiness in deterministic order while a real call is open.
   rest=[pool.submit(self.call,configs[i],[f'Page {i} line A',f'Page {i} line B']) for i in range(1,4)]
   import time
   deadline=time.monotonic()+2
   while not all(t.units is not None for t in tickets[1:]) and time.monotonic()<deadline:time.sleep(.001)
   self.release.set();results=[first.result(4)]+[f.result(4) for f in rest]
  self.assertEqual(len(self.seen),2)
  self.assertEqual(self.seen[1].unit_count,6)
  self.assertNotIn('ขอบเขตภาพ',self.seen[1].user_parts[-1])
  self.assertTrue(self.seen[1].user_parts[-1].startswith('<<I2_P0:'))
  self.assertNotIn('ข้อความต้นฉบับ',self.seen[1].user_parts[-1])
  for index,r in enumerate(results[1:]):
   texts=markers.extract_paragraphs_exact(r['aiTextFull'],2)[0]
   self.assertEqual(texts,[f'คำแปล{index*2}',f'คำแปล{index*2+1}'])
  ids=[r['meta']['usage']['generations'][0]['receiptId'] for r in results[1:]]
  self.assertEqual(len(set(ids)),1)
  with accounting._schema_lock:
   self.assertEqual(len(accounting._receipt_cache),2)
  self.assertFalse(Path(self.temp.name+'/u.db').exists())
  folders=list((Path(self.temp.name)/'wire').glob('*'))
  native=[f for f in folders if (f/'04_provider_request.json').exists()]
  self.assertEqual(len(native),2)
  mapping=next(m for f in native if len((m:=json.loads((f/'08_batch_mapping.json').read_text()))['origins'])==3)
  self.assertEqual(sum(len(p['unitIds']) for p in mapping['origins']),6)
  self.assertFalse(any('PRIVATE_KEY' in p.read_text() for folder in native for p in folder.iterdir() if p.is_file()))
 def test_api_page_atomic_dynamic_capacity(self):
  a=self.ai(0)
  class Owner: pass
  anchor_owner=Owner()
  anchor_rows=[{'ticket':anchor_owner,'index':i,'text':'ก'*30} for i in range(9)]
  cold={'successes':0,'cacheRatio':0,'cacheConfirmed':False,'ratios':[],'reasoning':0}
  picked0,estimate0,reason0=select_rows(anchor_rows,a,'th',cold)
  self.assertEqual(len(picked0),9)
  self.assertEqual(reason0,'ready_queue_drained')
  self.assertEqual(estimate0['conversationCapacity'],'anchor')

  # Production 14.27 shape after the 9-unit anchor: 7/12/12 READY units.
  owners=[Owner(),Owner(),Owner()];sizes=[7,12,12];rows=[]
  for owner,size in zip(owners,sizes):
   rows.extend({'ticket':owner,'index':i,'text':'ก'*30} for i in range(size))
  live={'successes':1,'cacheRatio':0,'cacheConfirmed':False,'cacheMissStreak':1,
   'lastCommittedUnits':9,'lastTurnMs':2000,'ratios':[],'reasoning':0}
  picked,estimate,reason=select_rows(rows,a,'th',live)
  self.assertEqual(len(picked),19)
  self.assertEqual(len({id(row['ticket']) for row in picked}),2)
  self.assertEqual(reason,'conversation_page_output_target')
  self.assertEqual(estimate['conversationCapacity'],'continuation_token_budget')
  self.assertGreaterEqual(estimate['recordTarget'],len(picked))
  cached={**live,'cacheRatio':.9,'cacheConfirmed':True,'cacheMissStreak':0,
   'lastCommittedUnits':19,'lastTurnMs':3000}
  picked2,estimate2,reason2=select_rows(rows,a,'th',cached)
  self.assertEqual(len(picked2),len(picked))
  self.assertEqual(estimate2['conversationCapacity'],'continuation_token_budget')
  heavy=replace(a,thinking='on',model_capabilities={**a.model_capabilities,
   'reasoning':{'supported':True,'mandatory':True,'supports_max_tokens':False},
   'limits':{'contextTokens':65536,'maxOutputTokens':16384}})
  slow={**cached,'lastCommittedUnits':9,'lastTurnMs':35000}
  picked3,estimate3,reason3=select_rows(rows,heavy,'th',slow)
  self.assertEqual(len(picked3),7)
  self.assertEqual(estimate3['conversationCapacity'],'continuation_token_budget')
  self.assertGreater(estimate3['completionAvailable'],8192)

 def test_webpage_order_waits_only_for_live_predecessors(self):
  a,b,c=[self.ai(i) for i in range(3)]
  ta,tb,tc=[ready_batch.reserve(x,'th') for x in (a,b,c)]
  with ThreadPoolExecutor(2) as pool:
   pending=pool.submit(self.call,c,['Last ready'])
   import time
   time.sleep(.03)
   self.assertEqual(len(self.seen),0)
   first=pool.submit(self.call,a,['Earlier source became ready later'])
   first.result(3)
   self.assertFalse(pending.done())
   ready_batch.finish(tb)
   r=pending.result(3)
  self.assertEqual(len(self.seen),2)
  self.assertIn('Earlier source became ready later',str(build_messages(self.seen[0])))
  self.assertIn('Last ready',str(build_messages(self.seen[-1])))
  self.assertEqual(r['meta']['conversation']['historyTurns'],1)
  self.assertEqual(r['meta']['conversation']['rolloverReason'],'none')
 def test_empty_predecessor_unblocks_and_other_owner_proceeds(self):
  a,b=self.ai(0),self.ai(1)
  ta,tb=[ready_batch.reserve(x,'th') for x in (a,b)]
  with ThreadPoolExecutor(2) as pool:
   pending=pool.submit(self.call,b,['Waiting page'])
   self.call(self.ai(0,'another-owner'),['Other document'])
   self.assertEqual(len(self.seen),1)
   self.assertFalse(pending.done())
   self.call(a,[])
   pending.result(3)
  self.assertEqual(len(self.seen),2)

 def test_automatic_retranslation_removes_future(self):
  self.call(self.ai(0),['Old start']);self.call(self.ai(1),['Old future'])
  r=self.call(self.ai(0),['Changed start'])
  self.assertEqual(r['meta']['conversation']['historyTurns'],0)
  self.assertEqual(r['meta']['conversation']['rolloverReason'],'source_changed')
  self.assertNotIn('Old future',str(build_messages(self.seen[-1])))
  r=self.call(self.ai(1),['New future']);self.assertEqual(r['meta']['conversation']['historyTurns'],1)
 def test_wrong_language_retranslation_retires_old_future_and_commits_structural_turn(self):
  self.call(self.ai(0),['Old start']);self.call(self.ai(1),['Old future'])
  self.bad=True;before=len(self.seen)
  with self.assertRaises(__import__('backend.ai.errors',fromlist=['ModelOutputContractError']).ModelOutputContractError):self.call(self.ai(0),['New start'])
  self.assertEqual(len(self.seen)-before,1)
  # The changed source branches history immediately. Its marker-valid assistant
  # reply is kept as the new cache transcript even though page validation rejects
  # the wrong-language unit and sends it to repair.
  self.bad=False;r=self.call(self.ai(1),['New future'])
  self.assertEqual(r['meta']['conversation']['historyTurns'],1)
  self.assertNotIn('Old future',str(build_messages(self.seen[-1])))
 def test_same_page_distinct_unit_groups_keep_history(self):
  a=self.ai(0)
  for number in range(2):
   a.conversation['origins']=[{'pageId':'page0','pageIndex':0,'unitIds':['P0'],'originalIds':[f'P{number}'],'sourceFingerprint':'a'*64}]
   r=translate(markers.apply(['chunk'+str(number)]),'th',a)
  self.assertEqual(r['meta']['conversation']['historyTurns'],1)
 def test_unknown_marker_text_is_not_committed_or_retried(self):
  self.answer_override=lambda ids,record:'<<TP_PBAD:unexpected>>\n'+record(ids[0],'คำแปล')
  before=len(self.seen)
  r=self.call(self.ai(0),['Hello'])
  self.assertEqual(len(self.seen)-before,1)
  self.assertEqual(r['meta']['conversation']['commitStatus'],'not_committed_invalid_output')
  self.assertEqual(r['meta']['conversation']['historyTurns'],0)
 def test_generated_bad_chunk_preserves_prior_good_units_and_usage(self):
  choose=ready_batch.registry.choose
  with patch.object(ready_batch.registry,'choose',side_effect=lambda rows,ai,target,p:choose(rows[:2],ai,target,p)):
   self.malformed_word='BROKEN_CHUNK'
   r=self.call(self.ai(0),['Good','Good again','BROKEN_CHUNK','Unread','Good last'])
  self.assertEqual(len(self.seen),3)
  values=markers.extract_paragraphs_exact(r['aiTextFull'],5)[0]
  self.assertEqual(values,['คำแปล0','คำแปล1','','','คำแปล0'])
  self.assertEqual(len(r['meta']['usage']['generations']),3)
  self.assertEqual(len({x['receiptId'] for x in r['meta']['usage']['generations']}),3)
 def test_private_scope_and_independent(self):
  self.call(self.ai(0),['Private first'])
  r=self.call(self.ai(1,'another'),['Other user']);self.assertEqual(r['meta']['conversation']['historyTurns'],0)
  a=replace(self.ai(2),translation_mode='independent')
  with patch('backend.ai.translation_paths.store.store',side_effect=AssertionError('old route touched history')):
   translate(markers.apply(['Old route']),'th',a)
  self.assertEqual(self.seen[-1].history_messages,())
 def test_bad_origin_mapping_fails_before_dispatch(self):
  with self.assertRaises(ValueError):checked_origins([{'pageId':'p','unitIds':['P0','P0'],'originalIds':['P0','P1']}])
  a=self.ai(0);a.conversation['origins']=[{'pageId':'p','unitIds':['P1'],'originalIds':['P0']}]
  with self.assertRaises(ValueError):translate(markers.apply(['bad origin']),'th',a)
  self.assertFalse(self.seen)
 def test_later_renderer_failure_keeps_once_only_receipt(self):
  from backend.ai.accounting import api_pipeline_scope,adopt_receipt_references
  @api_pipeline_scope
  def wrapper(payload):
   r=self.call(self.ai(0),['Hello'])
   adopt_receipt_references(r['meta']['usage'])  # Already adopted: cannot count twice.
   raise RuntimeError('synthetic later renderer failure')
  with self.assertRaises(RuntimeError) as fail:wrapper({'idempotency_key':'owner-error'})
  self.assertEqual(fail.exception.generationAttempts,1)
  self.assertEqual(fail.exception.generationMeta['usage']['totalTokens'],1020)
  with accounting._schema_lock:
   self.assertEqual(len(accounting._receipt_cache),1)
  self.assertFalse(Path(self.temp.name+'/u.db').exists())
 def test_typed_diagnostics_drop_secrets(self):
  v=sanitize_conversation_batch({'schema':'tp.conversation_batch/1','batchId':str(__import__('uuid').uuid4()),'pageCount':3,'unitCount':15,'estimatedInput':1200,'apiKey':'SECRET','history':['PRIVATE']})
  self.assertEqual(v['pageCount'],3);self.assertNotIn('apiKey',v);self.assertNotIn('history',v)
  self.assertEqual(sanitize_conversation({'schema':'tp.conversation/1','formattingWhitespaceChars':2,'unexpectedProseChars':0})['unexpectedProseChars'],0)

if __name__=='__main__':unittest.main(verbosity=2)
