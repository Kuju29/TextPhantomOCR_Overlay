"""Cold API/client proof -> actual Off response -> catalogue refresh regression.
Transport mocked; accepts TP_TEST_ROOT to reproduce the same test on a baseline.
"""
import os, sys, unittest
from pathlib import Path
from unittest.mock import patch
root = Path(os.environ.get('TP_TEST_ROOT', Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(root/'api'))
from backend.ai.provider_bootstrap import ensure_provider_registry
ensure_provider_registry()
from backend.ai import provider_resolution as cache
from backend.ai.providers import cloud_huggingface as hf
from backend.ai.provider_contract import GenerationRequest
from backend.ai.clients.base import ChatResult
MODEL='fixture/model'; KEY='hf_fixture_only'; BASE=hf.DEFAULT_BASE_URL
CAP={'reasoning':{'supported':True,'mandatory':False,'control':'levels','supported_efforts':['none','low']}}
class BootstrapOff(unittest.TestCase):
 def setUp(self):
  cache._MODEL_CAPABILITIES.clear();cache._MODEL_PROMOTIONS.clear()
  self.clock=patch.object(cache.time,'monotonic',return_value=1000.);self.clock.start();self.addCleanup(self.clock.stop)
 def caps(self,key=KEY,model=MODEL,base=BASE):
  return cache.discovered_model_capabilities('huggingface',base,model,key)[1]
 def generate(self,cap=CAP,tokens=0,thinking='off',during=None,returned_model=MODEL):
  request=GenerationRequest(provider='huggingface',model=MODEL,api_key=KEY,base_url=BASE,
    system_text='fixture',user_parts=('<<TP_P0:hello>>',),expected_ids=('P0',),unit_count=1,
    thinking=thinking,model_capabilities=cap)
  def response(**kwargs):
   if during:during()
   return ChatResult('<<TP_P0:hello>>',returned_model,thinking_tokens=tokens)
  with patch.object(hf,'execute_huggingface_chat',side_effect=response) as call:
   hf.ADAPTER.generate(request)
  return call.call_args.kwargs['payload']
 def refresh(self,models=None,caps=None):
  cache.remember_model_capabilities('huggingface',BASE,KEY,caps or {},models=[MODEL] if models is None else models)
 def test_restart_generation_then_empty_catalogue(self):
  self.assertEqual(self.generate().get('reasoning_effort'),'none')
  self.refresh()
  self.assertEqual(self.caps().get('reasoning',{}).get('supported_efforts'),['none'])
  self.assertEqual(self.generate(self.caps()).get('reasoning_effort'),'none')
 def test_do_not_infer_on_support(self):
  self.generate();self.assertEqual(self.caps()['reasoning']['supported_efforts'],['none'])
 def test_unrelated_returned_model_not_proof(self):
  self.generate(returned_model='other/model');self.refresh();self.assertNotIn('reasoning',self.caps())
 def test_unknown_reasoning_is_not_zero(self):
  self.generate(tokens=None);self.refresh();self.assertNotIn('reasoning',self.caps())
 def test_provider_ignored_off_does_not_gain_proof(self):
  self.generate(tokens=42);self.refresh();self.assertNotIn('reasoning',self.caps())
 def test_no_native_control_no_proof(self):
  self.generate(cap={});self.refresh();self.assertNotIn('reasoning',self.caps())
 def test_on_request_does_not_prove_off(self):
  self.generate(thinking='on');self.refresh();self.assertNotIn('reasoning',self.caps())
 def test_account_endpoint_model_isolation(self):
  self.generate();self.assertEqual(self.caps(key='other'),{});self.assertEqual(self.caps(model='other'),{});self.assertEqual(self.caps(base='http://other'),{})
 def test_live_catalogue_negative_wins(self):
  self.refresh(caps={MODEL:{'reasoning':{'supported':False}}});self.generate()
  self.assertEqual(self.caps()['reasoning']['supported'],False)
 def test_removed_model_not_resurrected(self):
  self.generate();self.refresh(models=[]);self.generate()
  self.assertNotIn('reasoning',self.caps())
 def test_inflight_logout_does_not_restore(self):
  self.generate(during=lambda:cache.forget_model_capabilities('huggingface',BASE,KEY));self.assertEqual(self.caps(),{})
 def test_inflight_refresh_supersedes_old_generation(self):
  self.generate(during=lambda:self.refresh(models=[]));self.assertNotIn('reasoning',self.caps())
 def test_existing_probe_ttl_not_extended(self):
  cache.remember_selected_model_capability('huggingface',BASE,KEY,MODEL,CAP)
  before=next(iter(cache._MODEL_CAPABILITIES.values()))['selected'][MODEL]['expires_at']
  with patch.object(cache.time,'monotonic',return_value=1200.):self.generate()
  after=next(iter(cache._MODEL_CAPABILITIES.values()))['selected'][MODEL]['expires_at']
  self.assertEqual(before,after)
 def test_expired_proof_not_kept_by_empty_refresh(self):
  self.generate()
  with patch.object(cache.time,'monotonic',return_value=2000.):
   self.refresh();self.assertNotIn('reasoning',self.caps())
if __name__=='__main__':unittest.main()
