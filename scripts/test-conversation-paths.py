"""Conversation route invariants; synthetic translations only, no live models."""
from contextlib import closing
from pathlib import Path
import copy, json, os, sys, tempfile, threading, time, unittest, sqlite3, subprocess
from unittest.mock import patch
from dataclasses import replace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.provider_registry import provider_registry
from backend.ai.clients.base import ChatResult
from backend.ai import markers, wire_trace
from backend.ai.translation_paths.store import Store, execution_scope, current
from backend.ai.translation_paths.mode import descriptor, mode, scope_material
from backend.ai.translation_paths.messages import native_history
from backend.ai.providers.openai_provider_runtime import build_messages
from backend.ai.workload import estimate_provider_input, guard_request_budget, WorkloadBudgetError
from backend.application.ai_translation.request_validation import build_config

class ConversationTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.env=patch.dict(os.environ,{'TP_CONVERSATION_STATE_FILE':self.temp.name+'/history.sqlite','TP_AI_WIRE_TRACE':'0','TP_USAGE_RECEIPTS':'off'});self.env.start();self.addCleanup(self.env.stop)
  self.discovery=patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{}));self.discovery.start();self.addCleanup(self.discovery.stop)
  self.requests=[];self.next_answer=None;self.complete=True;self.cached=None
  def generate(request):
   self.requests.append(request)
   text=self.next_answer if self.next_answer is not None else ('{"P0":"คำแปล"}' if request.response_schema else '<<TP_P0:คำแปล>>')
   return ChatResult(text=text,used_model=request.model,input_tokens=100,output_tokens=10,total_tokens=110,thinking_tokens=0,
     terminal_completed=self.complete,terminal_evidence='provider_done',finish_reason='stop',cached_input_tokens=self.cached)
  self.mock=patch.object(provider_registry.require('huggingface').adapter,'generate',side_effect=generate);self.mock.start();self.addCleanup(self.mock.stop)
  self.ai=AiConfig(api_key='PRIVATE_TEST_CREDENTIAL',provider='huggingface',model='fixture',base_url='https://router.huggingface.co/v1',
   translation_mode='conversation',source_lang='en',memory_mode='off',
   conversation=descriptor({'documentId':'test-document'},context={'tp_tab_session':'caller-one'}),
   model_capabilities={'structured_output':{'supported':False},'limits':{'contextTokens':65536}})
 def call(self,text='Hello',ai=None,**kw):return translate(markers.apply([text]),'th',ai or self.ai,**kw)
 def test_abc_def_append_without_bootstrap_examples(self):
  a=self.call('Page A');b=self.call('Page C');c=self.call('Page E')
  self.assertEqual([r['meta']['conversation']['historyTurns'] for r in (a,b,c)],[0,1,2])
  self.assertEqual([r['meta']['conversation']['commitStatus'] for r in (a,b,c)],['committed']*3)
  self.assertEqual([r['meta']['conversation']['bootstrapExamplesIncluded'] for r in (a,b,c)],[False,False,False])
  self.assertEqual([r['meta']['conversation']['bootstrapExamplesPersisted'] for r in (a,b,c)],[False,False,False])
  layouts=[r['meta']['promptLayout'] for r in (a,b,c)]
  self.assertEqual([x['examplesIncluded'] for x in layouts],[False,False,False])
  self.assertEqual([x['bootstrapExamplesChars'] for x in layouts],[0,0,0])
  self.assertEqual(len({x['userStaticChars'] for x in layouts}),1)
  self.assertEqual([r['meta']['promptLayoutScope'] for r in (a,b,c)],['effective_provider_request']*3)
  m=[build_messages(r) for r in self.requests]
  first_user=m[0][-1]['content']; second_history=m[1][1]['content']; second_current=m[1][-1]['content']
  self.assertNotIn('H01\nEN:',first_user)
  self.assertEqual(second_history,first_user);self.assertNotIn('H01\nEN:',second_current)
  self.assertNotIn('P1000000',first_user);self.assertNotIn('P1000000',second_history)
  self.assertIn('Page A',second_history);self.assertIn('Page C',second_current);self.assertNotIn('Page A',second_current)
  self.assertEqual(m[1][:2],m[0]);self.assertEqual(m[2][:4],m[1])
  self.assertEqual(m[1][2],{'role':'assistant','content':'<<TP_P0:คำแปล>>'})
  self.assertEqual(len(self.requests),3)
  self.assertEqual(a['meta']['usage']['totalTokens'],110)
 def test_image_record_conversation_forces_markers_even_when_model_supports_schema(self):
  a=copy.deepcopy(self.ai)
  a.model_capabilities={'structured_output':{'supported':True,'strict':True,'source':'fixture'},'limits':{'contextTokens':65536}}
  a.conversation['origins']=[{'pageId':'page-1','pageIndex':0,'pageOrder':1,'unitIds':['I1_P0'],'originalIds':['g0']}]
  self.next_answer='<<I1_P0:คำแปล>>'
  result=self.call('Page A',ai=a)
  request=self.requests[-1]
  self.assertIsNone(request.response_schema,'Conversation image records must stay marker-only on schema-capable models')
  self.assertEqual(request.expected_ids,('I1_P0',))
  self.assertIn('<<I1_P0:',request.user_parts[0])
  self.assertEqual(result['meta']['conversation']['recordProtocol'],'tp.translation.image-records/1')
  self.assertEqual(result['meta']['conversation']['commitStatus'],'committed')

 def test_recoverable_line_malformed_image_records_keep_conversation_history(self):
  a=copy.deepcopy(self.ai)
  a.conversation['origins']=[{'pageId':'page-1','pageIndex':0,'pageOrder':1,
   'unitIds':['I1_P0','I1_P1','I1_P2','I1_P3'],'originalIds':['g0','g1','g2','g3']}]
  self.next_answer='<<I1_P0:เสียศูนย์>\n<<I1_P1:เสียหนึ่ง>\n<<I1_P2:ดีสอง>>\n<<I1_P3:ดีสาม>>'
  first=translate(markers.apply(['One','Two','Three','Four']),'th',a)
  self.assertEqual(first['meta']['conversation']['commitStatus'],'committed')
  self.assertEqual(first['meta']['malformed_output_record_count'],2)
  self.assertTrue(first['meta']['malformed_output_recoverable'])
  b=copy.deepcopy(a)
  b.conversation['origins']=[{'pageId':'page-2','pageIndex':1,'pageOrder':2,
   'unitIds':['I2_P0','I2_P1','I2_P2','I2_P3'],'originalIds':['h0','h1','h2','h3']}]
  self.next_answer='<<I2_P0:รอบถัดไป>>\n<<I2_P1:สอง>>\n<<I2_P2:สาม>>\n<<I2_P3:สี่>>'
  second=translate(markers.apply(['Next one','Next two','Next three','Next four']),'th',b)
  self.assertEqual(second['meta']['conversation']['historyTurns'],1,
   'recoverable line-bounded marker damage must not erase the otherwise usable turn from Conversation')
  replay=build_messages(self.requests[-1])
  self.assertEqual(replay[2]['content'],'<<I1_P2:ดีสอง>>\n<<I1_P3:ดีสาม>>',
   'Conversation history must replay only canonical accepted records, never malformed provider bytes')

 def test_independent_schema_capability_remains_frozen_reference(self):
  a=replace(self.ai,translation_mode='independent',model_capabilities={'structured_output':{'supported':True,'strict':True,'source':'fixture'},'limits':{'contextTokens':65536}})
  self.next_answer='{"P0":"คำแปล"}'
  self.call('Independent source',ai=a)
  request=self.requests[-1]
  self.assertIsNotNone(request.response_schema,'Independent must retain its existing schema-capable path')
  self.assertEqual(request.expected_ids,('P0',))
  self.assertFalse(request.history_messages)

 def test_independent_never_enters_store(self):
  with patch('backend.ai.translation_paths.store.store',side_effect=AssertionError('store touched')):
   self.call(ai=replace(self.ai,translation_mode='independent'));self.call(ai=replace(self.ai,translation_mode='independent'))
  self.assertFalse(any(r.history_messages for r in self.requests))
  self.assertEqual(self.requests[0].user_parts,self.requests[1].user_parts)
 def test_repair_appends_then_main_continues(self):
  self.call('first'); repair=copy.deepcopy(self.ai);repair.conversation['branch']='repair'
  r=self.call('repair input',ai=repair);n=self.call('next')
  self.assertEqual(r['meta']['conversation']['commitStatus'],'committed')
  self.assertEqual(n['meta']['conversation']['historyTurns'],2)
  self.assertIn('repair input',json.dumps(list(self.requests[-1].history_messages),default=dict))
 def test_wrong_language_turn_stays_in_conversation_for_repair(self):
  self.next_answer='<<TP_P0:これは翻訳ではありません>>';r=self.call()
  self.assertEqual(r['meta']['conversation']['commitStatus'],'committed')
  self.next_answer=None;self.assertEqual(self.call()['meta']['conversation']['historyTurns'],1)
 def test_partial_not_committed(self):
  self.next_answer='<<TP_P0:>>';self.call()
  self.next_answer=None;self.assertEqual(self.call()['meta']['conversation']['historyTurns'],0)
 def test_nonterminal_failure_releases_lane(self):
  self.complete=False
  with self.assertRaises(Exception):self.call()
  self.complete=True;self.assertEqual(self.call()['meta']['conversation']['historyTurns'],0)
 def test_cancelled_before_dispatch(self):
  with self.assertRaises(Exception):self.call(cancel_check=lambda:True)
  self.assertEqual(len(self.requests),0)
  self.assertEqual(self.call()['meta']['conversation']['historyTurns'],0)
 def test_provider_exception_never_commits(self):
  self.mock.stop()
  with patch.object(provider_registry.require('huggingface').adapter,'generate',side_effect=RuntimeError('synthetic provider failure')):
   with self.assertRaises(RuntimeError):self.call()
  self.mock.start();self.assertEqual(self.call()['meta']['conversation']['historyTurns'],0)
 def test_cache_zero_and_unknown_do_not_affect_history(self):
  self.cached=None;a=self.call();self.cached=0;b=self.call();self.cached=50;c=self.call()
  self.assertEqual([r['meta']['conversation']['providerCacheStatus'] for r in (a,b,c)],['not_reported','reported_zero','reported_hit'])
  self.assertEqual(c['meta']['conversation']['historyTurns'],2)
  self.assertEqual(c['meta']['usage']['totalTokens'],110)
 def test_private_scope_separates_user_key_model_language_document_reset(self):
  self.call();scope=self.call()['meta']['conversation']['scope']
  for field,value in [('api_key','other-private'),('model','different'),('source_lang','ja'),('prompt_editable','Use a calm voice')]:
   a=replace(self.ai,**{field:value});self.assertEqual(self.call(ai=a)['meta']['conversation']['historyTurns'],0)
  for field,value in [('owner','another'),('documentId','new-doc'),('reset','reset-2')]:
   a=copy.deepcopy(self.ai);a.conversation[field]=value;self.assertEqual(self.call(ai=a)['meta']['conversation']['historyTurns'],0)
  self.assertEqual(self.call()['meta']['conversation']['scope'],scope)
 def test_ephemeral_is_explicit_not_global_shared_state(self):
  a=replace(self.ai,conversation={});self.call(ai=a);b=self.call(ai=a)
  self.assertEqual(b['meta']['conversation']['historyTurns'],0)
  self.assertEqual(b['meta']['conversation']['commitStatus'],'ephemeral_not_retained')
 def test_context_rollover_discards_whole_turns_only(self):
  self.call('first')
  from backend.ai.translation_paths.store import store
  db=store();key=db.key(scope_material(self.ai,'th'))
  with db.wakeup:
   db._rows[key]['history'][0]['user']='old '*200000
  result=self.call('current source')
  self.assertEqual(result['meta']['conversation']['historyTurns'],0)
  self.assertEqual(result['meta']['conversation']['trimmedTurns'],1)
  self.assertIn('current source',self.requests[-1].user_parts[0])
 def test_budget_counts_history_but_does_not_edit_current_source(self):
  self.call();self.call()
  r=self.requests[-1]
  short=estimate_provider_input(system=r.system_text,parts=r.user_parts)
  long=estimate_provider_input(system=r.system_text,parts=r.user_parts,history=r.history_messages)
  self.assertGreater(long,short)
  small=replace(r,model_capabilities={'limits':{'contextTokens':long+10}},workload={'version':1,'predictedOutput':500})
  with self.assertRaises(WorkloadBudgetError):guard_request_budget(small,1024)
 def test_scope_data_cannot_supply_history(self):
  with self.assertRaises(ValueError):descriptor({'history':[]})
  with self.assertRaises(ValueError):mode('unknown')
 def test_http_default_and_explicit_old_path(self):
  body={'provider':{'id':'huggingface','apiKey':'test','model':'fixture'},'context':{'tp_tab_session':'owner','page_url':'page'},'conversation':{'reset':'1'}}
  self.assertEqual(build_config(body).translation_mode,'conversation')
  self.assertEqual(build_config({**body,'translationMode':'independent'}).translation_mode,'independent')
 def test_process_memory_late_completion_fenced(self):
  a=Store(self.temp.name+'/shared.db')
  key=a.key('material');old=a.try_acquire(key);self.assertIsNone(a.try_acquire(key))
  with a.wakeup:a._rows[key]['until']=0
  new=a.try_acquire(key);old.history=[{'user':'stale','assistant':'stale'}]
  self.assertFalse(a.release(old,commit=True));new.history=[{'user':'new','assistant':'new'}];self.assertTrue(a.release(new,commit=True))
  final=a.try_acquire(key);self.assertEqual(final.history[0]['user'],'new');a.release(final)
  self.assertNotEqual(a.key('material'),Store(a.path).key('material'))
 def test_commit_storage_failure_does_not_hide_billed_answer(self):
  with patch.object(Store,'release',side_effect=RuntimeError('synthetic memory store failure')):
   r=self.call()
  self.assertEqual(r['meta']['usage']['totalTokens'],110)
  self.assertEqual(r['meta']['conversation']['commitStatus'],'not_committed_storage_error')
 def test_final_wire_status_matches_return_after_commit(self):
  with patch.dict(os.environ,{'TP_AI_WIRE_TRACE':'1','TP_AI_WIRE_TRACE_DIR':self.temp.name+'/wire'}):
   token=wire_trace.begin({'traceId':'fixture','operationId':'conversation-test'})
   p=wire_trace.active_folder();self.assertIsNotNone(p)
   try:r=self.call()
   finally:wire_trace.end(token)
  e=json.loads((p/'03_conversation_path.json').read_text());self.assertEqual(e,r['meta']['conversation'])
  d=json.loads((p/'06_parsed_records.json').read_text());self.assertEqual(d['meta']['conversation']['commitStatus'],'committed')
  self.assertNotIn('PRIVATE_TEST_CREDENTIAL',''.join(x.read_text() for x in p.iterdir() if x.is_file()))
 def test_executed_revision_change_drops_old_history(self):
  self.call('old revision')
  a=copy.deepcopy(self.ai);a.model_capabilities['limits']['modelRevision']='new-revision'
  result=self.call('new revision',ai=a)
  self.assertEqual(result['meta']['conversation']['historyTurns'],0)
  self.assertEqual(result['meta']['conversation']['rolloverReason'],'request_profile_changed')
  self.assertEqual(result['meta']['conversation']['trimmedTurns'],1)
 def test_separate_process_starts_empty(self):
  self.call('stored before restart')
  from backend.ai.translation_paths.store import store
  db=store();key=db.key(scope_material(self.ai,'th'))
  program="""from backend.ai.translation_paths.store import Store
import json,sys
s=Store(sys.argv[1]);lease=s.try_acquire(sys.argv[2]);assert lease is not None
print(json.dumps({'turns':len(lease.history)}));s.release(lease)
"""
  process=subprocess.run([sys.executable,'-c',program,str(db.path),key],capture_output=True,text=True,env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'api')})
  self.assertEqual(process.returncode,0,process.stderr)
  self.assertEqual(json.loads(process.stdout)['turns'],0)
  self.assertFalse(db.path.exists())
 def test_native_role_mapping(self):
  rows=[{'role':'user','text':'source'},{'role':'assistant','text':'answer'}]
  for protocol in ['openai','openai_image_first','ollama','anthropic','gemini']:
   out=native_history(rows,protocol);self.assertEqual(len(out),2)
   self.assertEqual(out[-1]['role'],'model' if protocol=='gemini' else 'assistant')

if __name__=='__main__':unittest.main(verbosity=2)
