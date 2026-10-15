"""Paired Paid transport/history and accounting regressions; no live calls."""
from dataclasses import replace
from pathlib import Path
import copy, json, os, runpy, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.provider_contract import GenerationRequest
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation_paths.conversation import prepare
from backend.ai.translation_paths.store import execution_scope, current
from backend.ai.translation_paths.mode import descriptor
from backend.ai.usage import normalize_usage
from backend.application.legacy_translation import semantic_fingerprint
from backend.ai.providers.cloud_paid import SPEC as PAID_SPEC
from backend.ai.provider_registry import provider_registry
if provider_registry.get("paid") is None: provider_registry.register(PAID_SPEC)


class CacheBilling(unittest.TestCase):
 def test_invalid_output_does_not_become_a_new_committed_ready_turn(self):
  from backend.ai.translation_paths.ready_registry import ReadyRegistry
  statuses=iter(("committed","not_committed_invalid_output","committed"))
  observed=[]
  def choose(rows,ai,target,profile):
   observed.append(profile.get("lastCommittedUnits",0));return rows,{},"fixture"
  def dispatch(rows,*_):
   return {"values":["answer"]*len(rows),"batchId":"fixture", "meta":{"conversation":{"commitStatus":next(statuses),"historyTurns":2}}}
  registry=ReadyRegistry(dispatch,choose,lambda t:t.values,lambda *_:None)
  ai=AiConfig(provider="huggingface",api_key="synthetic",model="fixture",translation_mode="conversation",
    conversation=descriptor({"documentId":"profile"},context={"tp_tab_session":"owner"}))
  for count in (2,3,4):registry.submit(registry.reserve(ai,"th"),["source"]*count,compat="same")
  self.assertEqual(observed,[0,2,2])

 def test_cache_duration_disagreement_is_not_reported_complete(self):
  usage=normalize_usage({"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,
   "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":200}},"anthropic")
  self.assertEqual(usage["usageStatus"],"inconsistent")
  self.assertIn("cache_write_duration_inconsistent",usage["accountingIssues"])

 def test_retry_semantics_exclude_only_transient_diagnostics(self):
  original={"ai":{"thinking":"minimum","memory_mode":"off","send_image":False},
    "metadata":{"page_index":3,"pipeline":[{"at":"one"}]},"context":{"page_url":"url"}}
  replay=copy.deepcopy(original)
  replay["ai"].update(api_key="PRIVATE",workload={"estimatedInput":1},model_capabilities={"limits":{}})
  replay["metadata"]["pipeline"]=[{"at":"two"}]
  replay["context"].update(timestamp="two",tp_trace="two")
  self.assertEqual(semantic_fingerprint(original),semantic_fingerprint(replay))
  for key,value in (("thinking","high"),("memory_mode","full"),("send_image",True)):
   changed=copy.deepcopy(original);changed["ai"][key]=value
   self.assertNotEqual(semantic_fingerprint(original),semantic_fingerprint(changed))

 def test_paid_replay_trims_whole_turns_before_center_limits(self):
  request=GenerationRequest(provider="paid",model="fixture",system_text="SYSTEM",user_parts=("STATIC\n\nCURRENT_SOURCE",),
    model_capabilities={"limits":{"contextTokens":2000000}},unit_count=1)
  layout={"userStaticChars":6,"instructionLocale":"en"}
  ai=AiConfig(provider="paid",api_key="synthetic",model="fixture",translation_mode="conversation",
    conversation=descriptor({"documentId":"budget"},context={"tp_tab_session":"owner"}))
  image="AAAA"*8192
  scenarios=[([{"user":"source "+str(i),"assistant":"answer "+str(i)} for i in range(60)],"",49),
    ([{"user":"old","assistant":"answer","image":image} for _ in range(40)],image,31),
    ([{"user":"old","assistant":"answer","image":"AAAA"*(1024*1024)} for _ in range(4)],"AAAA"*(1024*1024),2),
    ([{"user":"x"*4000,"assistant":"a"*4000} for _ in range(30)],"",22)]
  with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{"TP_AI_WIRE_TRACE":"0","TP_CONVERSATION_STATE_FILE":temp+"/state"}), \
       patch("backend.ai.translation_paths.conversation.estimate_provider_input",return_value=100), \
       patch("backend.ai.translation_paths.conversation.MAX_HISTORY_CHARS",20*1024*1024):
   for case,(turns,current_image,expected) in enumerate(scenarios):
    case_ai=replace(ai,conversation=descriptor({"documentId":f"budget-{case}"},context={"tp_tab_session":"owner"}))
    with self.subTest(turns=len(turns),image=bool(current_image)),execution_scope(case_ai,"th"):
     lease=current();lease.history=copy.deepcopy(turns);lease.prefix=""
     output=prepare(replace(request,image_b64=current_image),layout,ai)
     self.assertEqual(lease.evidence["rolloverReason"],"paid_transport_budget")
     self.assertEqual(len(output.history_messages),expected*2)
     self.assertIn("CURRENT_SOURCE",output.user_parts[0])
     self.assertEqual(output.image_b64,current_image)
     self.assertTrue(lease.prepared["history"][0]["anchor"])
     self.assertEqual(lease.history,turns,"Committed input turns must not be rewritten")
     lease.history=[] # Synthetic input must not be committed on fixture close.
   with execution_scope(ai,"th"):
    current().history=[];current().prefix=""
    oversized=replace(request,user_parts=("STATIC\n\n"+"CURRENT"*10000,))
    output=prepare(oversized,layout,ai)
    self.assertTrue(output.user_parts[0].endswith("CURRENT"*10000),"Oversized current source is left intact for authoritative refusal")

 def test_groq_nested_stream_usage_and_duplicates(self):
  helpers=runpy.run_path(str(Path(__file__).with_name("test-openai-stream-completion.py")),run_name="fixture")
  from backend.ai.transports.openai_chat import execute_chat_completion
  client=helpers["Client"]
  usage={"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_tokens_details":{"cached_tokens":80}}
  for duplicate in (False,True):
   terminal={"choices":[{"delta":{},"finish_reason":"stop"}],"x_groq":{"usage":usage}}
   if duplicate: terminal["usage"]=usage
   client.lines=["data: "+json.dumps({"choices":[{"delta":{"content":"<<TP_P0:translated>>"}}]}),
     "data: "+json.dumps(terminal),"data: [DONE]"]
   with patch.object(helpers["httpx"],"Client",client):
    result=execute_chat_completion(url="https://api.groq.com/openai/v1/chat/completions",headers={},payload={"messages":[]},
      model="openai/gpt-oss-20b",provider_id="groq",timeout=1,timeout_policy="fixture",expected_ids=["P0"])
   self.assertEqual(result.input_tokens,100);self.assertEqual(result.total_tokens,105)
   self.assertEqual(result.cached_input_tokens,80)

 def test_paid_current_image_above_history_capacity_refuses_before_dispatch(self):
  from backend.ai.translation_paths.store import ConversationError
  request=GenerationRequest(provider="paid",model="fixture",system_text="SYSTEM",user_parts=("STATIC\n\nCURRENT",),
    image_b64="AAAA"*300000,model_capabilities={"limits":{"contextTokens":2000000}})
  ai=AiConfig(provider="paid",api_key="synthetic",model="fixture",translation_mode="conversation",
    conversation=descriptor({"documentId":"too-large"},context={"tp_tab_session":"owner"}))
  with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{"TP_AI_WIRE_TRACE":"0","TP_CONVERSATION_STATE_FILE":temp+"/state"}),execution_scope(ai,"th"):
   with self.assertRaises(ConversationError) as refused:
    prepare(request,{"userStaticChars":6,"instructionLocale":"en"},ai)
   self.assertEqual(refused.exception.code,"ai_conversation_history_capacity")
   self.assertFalse(refused.exception.requestDispatched)

if __name__ == "__main__": unittest.main()
