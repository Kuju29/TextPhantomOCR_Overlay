"""Production admission/executor ordering: no provider slot held for cache wait."""
import asyncio, threading, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.jobs.admission import AdmissionGate
from backend.application.ai_translation import provider_execution
from backend.ai.cache_coordination import PrefixCoordinator

async def main():
 gate=AdmissionGate(2,max_waiters=32,max_wait_sec=3);coordinator=PrefixCoordinator();started=threading.Event();release=threading.Event();calls=[]
 executor=ThreadPoolExecutor(3)
 def translate(text,lang,cfg,**kwargs):
  lease=coordinator.acquire(provider='huggingface',model='x',endpoint='https://router.huggingface.co/v1',account=cfg.api_key,prefix='a'*64,target='th',source='en')
  lease.dispatched();calls.append(text)
  if text=='A1':started.set();assert release.wait(4)
  return {'meta':{'cacheCoordination':lease.finish(complete=True,cached=0)}}
 def ctx(name,key,identity):
  return NS(trace_id='',payload={'operationId':name},marked=name,target_lang='th',config=NS(api_key=key,model='x'),
   request=NS(app=NS(state=NS(ai_admission_gate=gate,ai_executor=executor))),identity=identity,
   correlation={},resolved_provider='huggingface',rate={'enabled':False},unlimited=False)
 try:
  with patch.object(provider_execution,'translate',side_effect=translate),patch('backend.ai.cache_coordination.emit'):
   a=asyncio.create_task(provider_execution.run(ctx('A1','PRIVATE_A','user-A'),rate_wait_ms=0))
   assert await asyncio.to_thread(started.wait,2)
   a2=asyncio.create_task(provider_execution.run(ctx('A2','PRIVATE_A','user-A'),rate_wait_ms=0))
   b=asyncio.create_task(provider_execution.run(ctx('B1','PRIVATE_B','user-B'),rate_wait_ms=0))
   r2,rb=await asyncio.wait_for(asyncio.gather(a2,b),1)
   assert not a.done(),'unrelated users must dispatch while A1 is still with provider'
   assert r2.result['meta']['cacheCoordination']['role']=='observer'
   assert rb.result['meta']['cacheCoordination']['role']=='leader'
   assert r2.result['meta']['cacheCoordination']['waitMs']==0
   assert rb.result['meta']['cacheCoordination']['waitMs']==0
   release.set();await a
   assert sorted(calls)==['A1','A2','B1'],'no warmup, repeat, or extra provider generation'
   assert gate.stats().running==0
 finally:
  release.set();executor.shutdown(wait=True)
 print('PASS production admission/executor: 3 real tasks, active leader does not gate another user or same-prefix observer; no added requests')

asyncio.run(main())
