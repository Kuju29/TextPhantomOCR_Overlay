"""Real invocation/adapter -> real loopback HTTP/SSE -> usage + wire artifacts.
HF URLs are redirected inside a test-only client; no external requests/models.
"""
import json,os,sys,time,threading,tempfile,hashlib
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from backend.ai import accounting,wire_trace,markers,cache_coordination as cache
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig

calls=[];lock=threading.Lock();first_seen=threading.Event();second_seen=threading.Event();release=threading.Event()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  with lock:
   index=len(calls);calls.append({'payload':payload,'time':time.perf_counter()})
  if index==0:first_seen.set();assert release.wait(5),'test leader not released'
  if index==1:second_seen.set()
  answer='<<TP_P0:ทดสอบ>>'
  record={'id':'fixture-'+str(index),'model':payload['model'],'choices':[{'index':0,'delta':{'content':answer},'finish_reason':None}]}
  usage={'prompt_tokens':3000,'completion_tokens':10,'total_tokens':3010,'prompt_tokens_details':{'cached_tokens':0 if index==0 else 2048},'completion_tokens_details':{'reasoning_tokens':0}}
  terminal={'id':record['id'],'model':payload['model'],'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':usage}
  data=('data: '+json.dumps(record,ensure_ascii=False)+'\n\ndata: '+json.dumps(terminal)+'\n\ndata: [DONE]\n\n').encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
original=httpx.Client
class LoopbackClient:
 _textphantom_streaming=True
 def __init__(self,*a,**kw):self.client=original(timeout=5,trust_env=False)
 def __enter__(self):return self
 def __exit__(self,*a):self.client.close()
 def stream(self,method,url,**kw):
  assert str(url).startswith('https://router.huggingface.co/'),url
  return self.client.stream(method,f'http://127.0.0.1:{server.server_port}/chat',**kw)

try:
 with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'TP_AI_WIRE_TRACE':'1','TP_AI_WIRE_TRACE_DIR':temp,'TP_USAGE_RECEIPTS':'off','TP_PROMPT_CACHE':'on','TP_PROMPT_CACHE_COORDINATION':'auto','TP_PROMPT_CACHE_WAIT_MS':'1000'}),patch.object(httpx,'Client',LoopbackClient),patch.object(cache,'_coordinator',cache.PrefixCoordinator()),patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})):
  cfg=AiConfig(provider='huggingface',model='deepseek-ai/fixture-model',api_key='PRIVATE_ACCOUNT',base_url='https://router.huggingface.co/v1',thinking='off',source_lang='en',memory_mode='off')
  def translate(i):
   token=wire_trace.begin({'traceId':'fixture','operationId':f'cache-http-{i}'})
   try:
    with accounting.receipt_scope('runsextension',f'cache-http-{i}'):
     return invocation._translate_once(markers.apply(['Hello '+str(i)]),'th',cfg)
   finally:wire_trace.end(token)
  with ThreadPoolExecutor(max_workers=2) as p:
   first=p.submit(translate,0);assert first_seen.wait(3)
   second=p.submit(translate,1)
   assert second_seen.wait(2),'second request must reach provider while leader is still active'
   b=second.result(timeout=2);assert not first.done(),'cache observer must not wait on the first response'
   release.set();a=first.result(timeout=5)
  d0=a['meta']['cacheCoordination'];d1=b['meta']['cacheCoordination']
  assert d0['role']=='leader' and d0['cacheStatus']=='reported_zero',d0
  assert d1['role']=='observer' and d1['waitMs']==0,d1
  assert d1['cacheStatus']=='reported_hit' and d1['cachedInputTokens']==2048,d1
  assert d1['groupId']==d0['groupId'] and d1['providerCacheReady'] is None
  assert b['meta']['provider_ms']>=0 and d1['providerCacheTtlMs'] is None
  third=translate(2);assert third['meta']['cacheCoordination']['role']=='leader'
  assert third['meta']['cacheCoordination']['reason']=='next_request'
  assert third['meta']['cacheCoordination']['previousCacheHit'] is True,'older zero must not replace newer hit'
  assert d0['latestObservationApplied'] is False
  assert third['meta']['cacheCoordination']['waitMs']==0
  assert len(calls)==3,'three source requests; zero warm-up generations'
  assert len({c['payload']['messages'][0]['content'] for c in calls})==1
  assert len({a['meta']['promptLayout']['staticPrefixSha256'],b['meta']['promptLayout']['staticPrefixSha256'],third['meta']['promptLayout']['staticPrefixSha256']})==1
  for i,result in enumerate([a,b,third]):
   assert result['meta']['usage']['totalTokens']==3010,'cache not subtracted from logical token total'
   folder=next(path.parent for path in Path(temp).glob('*/00_identity.json') if json.loads(path.read_text()).get('operationId')==f'cache-http-{i}')
   raw=(folder/'05_provider_response.raw').read_text();assert 'cached_tokens' in raw
   d=json.loads((folder/'03_cache_coordination.json').read_text());assert d['phase']=='finished'
   assert d==result['meta']['cacheCoordination']
   request=json.loads((folder/'04_provider_request.json').read_text())['body']
   assert request==calls[i]['payload'],'cache evidence never enters provider body'
   assert 'session_id' not in request and 'prompt_cache_key' not in request,'HF controls not invented'
   assert 'PRIVATE_ACCOUNT' not in '\n'.join(f.read_text() for f in folder.iterdir() if f.is_file())
  print(json.dumps({'checks':18,'requests':len(calls),'extraWarmupRequests':0,'observerWaitMs':d1['waitMs'],'providerMs':b['meta']['provider_ms'],'scope':'actual loopback HTTP/SSE + invocation, usage, wire; no live model'}))
finally:
 release.set();server.shutdown();server.server_close()
