"""No-wait leases and bounded observations; no external model calls."""
import os, sys, time, threading, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai import cache_coordination as mod
from backend.ai.clients.base import ProviderGenerationCancelled
from backend.diagnostic_schema import sanitize_cache_coordination

BASE=dict(provider='huggingface',model='fixture-model',endpoint='https://router.huggingface.co/v1',
          account='PRIVATE_A',prefix='a'*64,target='th',source='en')

class Tests(unittest.TestCase):
 def setUp(self):
  self.events=[];self.p=patch.object(mod,'emit',side_effect=self.events.append);self.p.start();self.addCleanup(self.p.stop)
 def test_no_wait_for_active_leader(self):
  c=mod.PrefixCoordinator();a=c.acquire(**BASE)
  with ThreadPoolExecutor(6) as p:
   futures=[p.submit(c.acquire,**BASE) for _ in range(20)]
   items=[f.result(timeout=.5) for f in futures]
  self.assertTrue(all(i.data['role']=='observer' and i.data['waitMs']==0 for i in items))
  self.assertFalse(a.finished);self.assertEqual(len(c._leaders),1)
  self.assertTrue(all(e['phase']!='waiting' for e in self.events))
 def test_next_real_request_becomes_leader_on_terminal(self):
  c=mod.PrefixCoordinator();a=c.acquire(**BASE);a.dispatched();a.finish(complete=True,cached=10,input_tokens=20)
  b=c.acquire(**BASE)
  self.assertEqual(b.key,a.key);self.assertEqual(b.data['role'],'leader');self.assertEqual(b.data['reason'],'next_request')
  self.assertTrue(b.data['previousCacheHit']);self.assertEqual(b.data['previousCompletions'],1)
  self.assertNotEqual(a.data['leaderCoordinationId'],b.data['leaderCoordinationId'])
 def test_failure_and_cancel_release_without_retry(self):
  for reason in ['failed','cancelled']:
   c=mod.PrefixCoordinator();a=c.acquire(**BASE);a.dispatched();a.finish(reason=reason)
   self.assertEqual(a.data['releaseReason'],'leader_'+reason)
   b=c.acquire(**BASE);self.assertEqual(b.data['role'],'leader');self.assertEqual(b.data['waitMs'],0)
 def test_cancel_before_acquire(self):
  c=mod.PrefixCoordinator()
  with self.assertRaises(ProviderGenerationCancelled):c.acquire(**BASE,cancel_check=lambda:True)
  self.assertEqual(len(c._leaders),0);self.assertEqual(len(c._observations),0)
 def test_lease_expiry_and_fenced_late_completion(self):
  now=[0.];c=mod.PrefixCoordinator(clock=lambda:now[0],lease_ms=100)
  a=c.acquire(**BASE);a.dispatched();now[0]=.11;b=c.acquire(**BASE);b.dispatched()
  self.assertEqual(b.data['reason'],'lease_expired');b.finish(complete=True,cached=0)
  a.finish(complete=True,cached=25)
  self.assertEqual(a.data['releaseReason'],'lease_superseded');self.assertFalse(a.data['latestObservationApplied'])
  d=c.acquire(**BASE);self.assertFalse(d.data['previousCacheHit']);self.assertEqual(d.data['previousCompletions'],2)
 def test_observer_cannot_release_current_leader(self):
  c=mod.PrefixCoordinator();a=c.acquire(**BASE);b=c.acquire(**BASE);b.dispatched();b.finish(complete=True,cached=10)
  self.assertIs(c._leaders[a.key],a.leader);a.dispatched();a.finish(complete=True,cached=0)
  self.assertFalse(a.data['latestObservationApplied']);self.assertTrue(c.acquire(**BASE).data['previousCacheHit'])
 def test_eviction_does_not_evict_active_leases_or_restore_stale_stats(self):
  c=mod.PrefixCoordinator(max_groups=1,max_active=4)
  a=c.acquire(**BASE);a.dispatched();other=c.acquire(**{**BASE,'account':'OTHER'})
  b=c.acquire(**BASE);b.dispatched()
  self.assertIs(a.leader,b.leader);self.assertEqual(b.data['role'],'observer')
  a.finish(complete=True,cached=10);self.assertFalse(a.data['observationRecorded'])
  b.finish(complete=True,cached=0);self.assertTrue(b.data['observationRecorded'])
  self.assertIs(c._leaders[other.key],other.leader)
 def test_capacity_never_blocks_translation_or_kills_leader(self):
  c=mod.PrefixCoordinator(max_groups=1,max_active=1)
  a=c.acquire(**BASE);b=c.acquire(**{**BASE,'model':'OTHER'})
  self.assertEqual(b.data['reason'],'leader_capacity');self.assertIsNone(b.leader)
  b.dispatched();b.finish(complete=True,cached=0)
  self.assertIs(c._leaders[a.key],a.leader)
 def test_idle_statistics_are_not_provider_ttl(self):
  now=[0.];c=mod.PrefixCoordinator(clock=lambda:now[0]);a=c.acquire(**BASE);a.dispatched();a.finish(complete=True,cached=5)
  now[0]=6000;v=c.acquire(**BASE)
  self.assertTrue(v.data['reusedGroup']);self.assertEqual(v.data['role'],'leader');self.assertEqual(v.data['waitMs'],0)
  self.assertIsNone(v.data['retentionMs']);self.assertIsNone(v.data['providerCacheTtlMs'])
  self.assertEqual(v.snapshot()['previousObservationAgeMs'],6000000)
 def test_zero_unknown_hit_and_invalid_usage(self):
  for cached,input_t,expected in [(None,100,'not_reported'),(0,100,'reported_zero'),(50,100,'reported_hit'),(150,100,'not_reported'),(True,100,'not_reported')]:
   c=mod.PrefixCoordinator();v=c.acquire(**BASE);v.dispatched();v.finish(complete=True,cached=cached,input_tokens=input_t)
   self.assertEqual(v.data['cacheStatus'],expected);self.assertIsNone(v.data['providerCacheReady'])
   self.assertIsNone(v.data['providerCacheTtlMs']);self.assertEqual(v.data['missReason'],'unknown')
 def test_unknown_newer_result_does_not_keep_old_hit(self):
  c=mod.PrefixCoordinator();a=c.acquire(**BASE);a.dispatched();a.finish(complete=True,cached=20)
  b=c.acquire(**BASE);b.dispatched();b.finish(complete=True)
  self.assertIsNone(c.acquire(**BASE).data['previousCacheHit'])
 def test_finish_idempotent_and_unattempted_usage_not_learned(self):
  c=mod.PrefixCoordinator();a=c.acquire(**BASE);a.finish(complete=True,cached=9)
  self.assertFalse(a.data['observationRecorded']);self.assertEqual(c.acquire(**BASE).data['previousCompletions'],0)
  b=c.acquire(**BASE);b.dispatched();x=b.finish(complete=True,cached=0);self.assertEqual(x,b.finish(complete=True,cached=5))
 def test_multiuser_multimodel_language_isolation_and_switchback(self):
  c=mod.PrefixCoordinator();keys=set()
  for account in range(30):
   for model in range(4):
    for lang in ['en','th','ja']:
     v=c.acquire(**{**BASE,'account':str(account),'model':str(model),'target':lang});v.dispatched();v.finish(complete=True,cached=0)
     keys.add(v.key)
  self.assertEqual(len(keys),360);self.assertEqual(len(c._observations),360);self.assertEqual(len(c._leaders),0)
  a=c.acquire(**BASE);a.finish()
  for field,value in [('account','PRIVATE_B'),('model','OTHER'),('endpoint','https://other.example'),('prefix','b'*64),('target','ja'),('source','ja'),('revision','r2'),('thinking','on'),('has_image',True),('response_schema',{'type':'object'})]:
   v=c.acquire(**{**BASE,field:value});self.assertNotEqual(v.key,a.key);v.finish()
  self.assertEqual(c.acquire(**BASE).key,a.key)
 def test_processes_are_independent_not_distributed(self):
  a,b=mod.PrefixCoordinator(),mod.PrefixCoordinator()
  self.assertNotEqual(a.acquire(**BASE).key,b.acquire(**BASE).key)
 def test_config_modes_and_legacy_wait_do_not_add_delay(self):
  with patch.dict(os.environ,{'TP_PROMPT_CACHE':'auto','TP_PROMPT_CACHE_COORDINATION':'auto','TP_PROMPT_CACHE_WAIT_MS':'10000'}):
   self.assertEqual(mod._mode('huggingface','x',BASE['endpoint']),'observe_only')
   self.assertEqual(mod._mode('huggingface','x','https://router.huggingface.co.evil/v1'),'unsupported')
   self.assertEqual(mod._mode('ollama','x','http://localhost:11434'),'runtime_managed')
  with patch.dict(os.environ,{'TP_PROMPT_CACHE_COORDINATION':'off'}):self.assertEqual(mod._mode('huggingface','x',BASE['endpoint']),'disabled')
  for mode in ['runtime_managed','disabled','unsupported']:
   c=mod.PrefixCoordinator();a=c.acquire(**BASE,mode=mode);b=c.acquire(**BASE,mode=mode);self.assertEqual(b.data['waitMs'],0)
  self.assertEqual(mod.PrefixCoordinator().acquire(**{**BASE,'prefix':''}).data['role'],'bypass')
 def test_sanitizer_cannot_claim_provider_expiry_readiness_or_expose_secret(self):
  v=mod.PrefixCoordinator().acquire(**BASE).snapshot()
  s=sanitize_cache_coordination({**v,'providerCacheTtlMs':100,'providerCacheReady':True,'api_key':'PRIVATE','prompt':'PRIVATE'})
  self.assertIsNone(s['providerCacheTtlMs']);self.assertIsNone(s['providerCacheReady']);self.assertNotIn('PRIVATE',str(s));self.assertGreater(len(s),30)
 def test_emit_failure_releases_lease(self):
  c=mod.PrefixCoordinator()
  with patch.object(mod,'emit',side_effect=RuntimeError('diagnostic write')):
   with self.assertRaises(RuntimeError):c.acquire(**BASE)
  self.assertEqual(len(c._leaders),0)

if __name__=='__main__':unittest.main()
