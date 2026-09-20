"""BYOK at discovery, probe, initial, repair, job and replay boundaries.

Only mock provider adapters are used. ASGI ingress and idempotency/cache code
are real; a configured operator secret must never authorize an absent user key.
"""
import asyncio, os, sys, tempfile, unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import ExitStack
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from backend.config import settings
from backend.ai import resolve as resolution, probe as probing
from backend.ai.credentials import request_api_key, MissingUserApiKey
from backend.ai.provider_registry import provider_registry
from backend.ai.translation.contracts import AiConfig
from backend.application.ai_translation.request_validation import build_config
from backend.application.ai_translation import idempotency_session
from backend.application import translate_context, translate_request, idempotency
from backend.jobs.stages.config import build_ai_config
from backend.jobs.cache import build_cache_key, LruCache
from backend.ai.rate_policy import is_local_target
from backend.api.routes import ai as ai_routes, ai_v1, meta

class Tests(unittest.TestCase):
 def setUp(self):
  self.old=settings.ai_api_key;object.__setattr__(settings,'ai_api_key','PRIVATE_SERVER_SECRET')
  self.addCleanup(lambda:object.__setattr__(settings,'ai_api_key',self.old))
  self.env=patch.dict(os.environ,{'AI_API_KEY':'PRIVATE_ENV_SECRET','TP_USAGE_RECEIPTS':'off'});self.env.start();self.addCleanup(self.env.stop)
 def test_cloud_configs_require_user_key_even_when_operator_key_exists(self):
  for repair in [False,True]:
   data={'provider':{'id':'huggingface','model':'fixture'},'repair':{'owner':'extension','enabled':not repair}}
   with self.assertRaises(MissingUserApiKey):build_config(data)
   cfg=build_config({**data,'provider':{**data['provider'],'apiKey':' USER_A '}})
   self.assertEqual(cfg.api_key,'USER_A');self.assertTrue(cfg.user_key)
  with self.assertRaises(MissingUserApiKey):build_ai_config({'ai':{'provider':'huggingface'}},'lens_text','ai')
  with self.assertRaises(MissingUserApiKey):build_ai_config({},'lens_text','ai')
  cfg=build_ai_config({'ai':{'provider':'huggingface','api_key':'USER_B'}},'lens_text','ai')
  self.assertEqual(cfg.api_key,'USER_B');self.assertTrue(cfg.user_key)
  self.assertIsNone(build_ai_config({},'lens_images','original'))
 def test_local_never_receives_cloud_key(self):
  for provider in ['ollama','lmstudio']:
   self.assertEqual(request_api_key(provider,'http://127.0.0.1:11434','USER_KEY'),'')
   a=build_config({'provider':{'id':provider,'baseUrl':'http://127.0.0.1:11434','apiKey':'USER_KEY'}})
   b=build_ai_config({'ai':{'provider':provider,'base_url':'http://127.0.0.1:11434','api_key':'USER_KEY'}},'lens_text','ai')
   for cfg in [a,b]:self.assertEqual(cfg.api_key,'');self.assertFalse(cfg.user_key)
 def test_missing_discovery_probe_never_network_on_any_cloud_adapter(self):
  cloud=[s for s in provider_registry if not s.local]
  with ExitStack() as stack:
   mocks=[]
   for spec in cloud:
    for method in ['list_models','probe','generate']:
     mocks.append(stack.enter_context(patch.object(spec.adapter,method,side_effect=AssertionError('network called without user key'))))
   for spec in cloud:
    r=resolution.resolve({'provider':spec.provider_id,'base_url':spec.default_base_url,'model':'fixture','lang':'th'})
    self.assertFalse(r['ok']);self.assertEqual(r['key_source'],'none');self.assertEqual(r['error'],'missing_api_key')
    r=probing.probe({'provider':spec.provider_id,'base_url':spec.default_base_url,'model':'fixture'})
    self.assertFalse(r['ok']);self.assertEqual(r['status'],'missing_api_key')
   self.assertEqual(resolution.resolve({'provider':'auto'})['error'],'missing_api_key')
   self.assertEqual(probing.probe({'provider':'auto'})['status'],'missing_api_key')
   self.assertTrue(all(m.call_count==0 for m in mocks))
 def test_supplied_key_used_for_model_discovery(self):
  enumeration=resolution.EnumerationResult(models=['fixture'],source='live',verified=True,status='valid',http_status=200,error='',capabilities={},candidates={})
  with patch.object(resolution,'_enumerate_models_detailed',return_value=enumeration) as listed:
   r=resolution.resolve({'provider':'huggingface','api_key':'hf_USER_KEY','model':'fixture'})
   self.assertTrue(r['ok']);self.assertEqual(r['key_source'],'user');self.assertEqual(listed.call_args.args[1],'hf_USER_KEY')
 def test_no_environment_fallback_in_runsapi_configuration(self):
  p={'mode':'lens_text','source':'ai','ai':{'provider':'huggingface'}}
  self.assertFalse(translate_context.ai_server_execution_configured(p,fallback_api_key='SERVER',is_local_target=is_local_target))
  request=Request({'type':'http','path':'/v2/engine/runsapi/translate','headers':[],'query_string':b'', 'client':('127.0.0.1',42)})
  with self.assertRaises(HTTPException) as e:translate_request.prepare(p,request)
  self.assertEqual(e.exception.status_code,400)
  self.assertTrue(translate_context.ai_server_execution_configured({**p,'ai':{'provider':'ollama','base_url':'http://127.0.0.1:11434'}},fallback_api_key='SERVER',is_local_target=is_local_target))
 def test_asgi_missing_key_reports_before_dispatch_and_meta_requires_user_key(self):
  async def run():
   app=FastAPI();app.include_router(ai_routes.router);app.include_router(ai_v1.router);app.include_router(meta.router)
   async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
    r=await c.get('/meta');self.assertFalse(r.json()['has_env_ai_key']);self.assertEqual(r.json()['credential_policy'],'user_required')
    r=await c.get('/v1/ai/schema');self.assertFalse(r.json()['hasServerKey'])
    for path in ['/ai/resolve','/ai/probe']:
     r=await c.post(path,json={'provider':'huggingface','model':'fixture','lang':'th'});self.assertEqual(r.status_code,200);self.assertFalse(r.json()['ok'])
    for path in ['/v1/ai/translate','/v2/engine/runsextension/ai/translate']:
     r=await c.post(path,json={'provider':{'id':'huggingface','model':'fixture'},'units':[{'id':'P0','text':'Hello'}],'targetLang':'th'})
     self.assertEqual(r.status_code,400);self.assertEqual(r.json()['detail']['code'],'missing_api_key')
     self.assertNotIn('PRIVATE',r.text)
  asyncio.run(run())
 def test_idempotency_separates_keys_even_with_same_tab_and_retry_key(self):
  async def run():
   idempotency.clear()
   request=Request({'type':'http','path':'/v1/ai/translate','headers':[],'query_string':b'','client':('127.0.0.1',42)})
   a={'provider':{'id':'huggingface','apiKey':'USER_A','model':'x'},'context':{'tp_tab_session':'same-tab'},'units':[{'id':'P0','text':'Hello'}],'targetLang':'th'}
   b={**a,'provider':{**a['provider'],'apiKey':'USER_B'}}
   ra=await idempotency_session.reserve(request,a,'same-operation')
   idempotency_session.store(ra,{'translations':[{'id':'P0','text':'PRIVATE_A_OUTPUT'}],'meta':{}})
   rb=await idempotency_session.reserve(request,b,'same-operation')
   self.assertNotEqual(ra.key,rb.key);self.assertIsNone(rb.replay)
   idempotency_session.store(rb,{'translations':[{'id':'P0','text':'PRIVATE_B_OUTPUT'}],'meta':{}})
   again=await idempotency_session.reserve(request,a,'same-operation')
   self.assertEqual(again.replay['translations'][0]['text'],'PRIVATE_A_OUTPUT')
   self.assertEqual(again.replay['meta']['providerAttempts'],0)
   idempotency.clear()
  asyncio.run(run())
 def test_private_result_cache_scope_and_nonfrozen_context(self):
  cfg=AiConfig(provider='huggingface',api_key='USER_A',model='x',base_url='https://router.huggingface.co/v1',series_state='PRIVATE_MEMORY_A',context_frozen=False)
  k=lambda c,owner='tab-A':build_cache_key('image','th','lens_text','ai',c,owner_scope=owner)
  a=k(cfg);self.assertNotEqual(a,k(replace(cfg,api_key='USER_B')))
  self.assertNotEqual(a,k(cfg,'tab-B'));self.assertNotEqual(a,k(replace(cfg,series_state='PRIVATE_MEMORY_B')))
  self.assertEqual(a,k(cfg));self.assertNotIn('USER_A',a);self.assertNotIn('PRIVATE_MEMORY',a)
  store=LruCache(10);store.set(a,{'answer':'PRIVATE_A_OUTPUT'});self.assertIsNone(store.get(k(replace(cfg,api_key='USER_B'))))
  read=store.get(a);read['answer']='changed';self.assertEqual(store.get(a)['answer'],'PRIVATE_A_OUTPUT')
 def test_env_value_not_loaded_into_new_settings(self):
  self.assertEqual(type(settings)().ai_api_key,'')

if __name__=='__main__':unittest.main()
