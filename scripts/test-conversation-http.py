"""Both API orchestration owners, real adapter -> loopback SSE, private process-lifetime history."""
import asyncio, json, os, sys, threading, tempfile, time, re
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from backend.ai import wire_trace, markers
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation_paths.mode import descriptor
from backend.ai.translation_paths.store import Store, current, store
from backend.application.ai_translation import provider_execution
from backend.jobs.admission import AdmissionGate
from backend.jobs.stages import ai_stage, config as job_config

calls=[];lock=threading.Lock();first_seen=threading.Event();release=threading.Event()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  with lock: index=len(calls);calls.append(payload)
  last=payload['messages'][-1]['content']
  if 'SLOW_SOURCE' in last:
   first_seen.set();assert release.wait(8),'test predecessor not released'
  ids=[a or b for a,b in re.findall(r'<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6})):',last)] or ['P0']
  answer='\r\n'.join((f'<<{id}:สวัสดี>>' if id.startswith('I') else f'<<TP_{id}:สวัสดี>>') for id in ids)
  record={'id':f'conversation-{index}','model':payload['model'],'choices':[{'index':0,'delta':{'content':answer},'finish_reason':None}]}
  usage={'prompt_tokens':3000,'completion_tokens':10,'total_tokens':3010,'prompt_tokens_details':{'cached_tokens':2048 if len(payload['messages'])>2 else 0},'completion_tokens_details':{'reasoning_tokens':0}}
  terminal={'id':record['id'],'model':payload['model'],'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':usage}
  data=('data: '+json.dumps(record,ensure_ascii=False)+'\n\ndata: '+json.dumps(terminal)+'\n\ndata: [DONE]\n\n').encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
RealClient=httpx.Client
class LoopbackClient:
 _textphantom_streaming=True
 def __init__(self,*a,**kw):self.client=RealClient(timeout=10,trust_env=False)
 def __enter__(self):return self
 def __exit__(self,*a):self.client.close()
 def stream(self,method,url,**kwargs):
  assert str(url).startswith('https://router.huggingface.co/'),url
  return self.client.stream(method,f'http://127.0.0.1:{server.server_port}/chat',**kwargs)

try:
 with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'TP_CONVERSATION_STATE_FILE':temp+'/state.sqlite','TP_AI_WIRE_TRACE':'1','TP_AI_WIRE_TRACE_DIR':temp+'/wire','TP_USAGE_RECEIPTS':'off'}),patch.object(httpx,'Client',LoopbackClient),patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})):
  cfg=AiConfig(provider='huggingface',model='fixture',api_key='PRIVATE_ACCOUNT',base_url='https://router.huggingface.co/v1',thinking='off',source_lang='en',memory_mode='off',translation_mode='conversation',conversation=descriptor({'documentId':'doc'},context={'tp_tab_session':'owner'}),model_capabilities={'limits':{'contextTokens':32768,'maxOutputTokens':4096}})
  def translate(i,config=cfg,text=None):
   token=wire_trace.begin({'traceId':'conversation','operationId':f'conversation-http-{i}'})
   try:return invocation.translate(markers.apply([text or 'Hello '+str(i)]),'th',config)
   finally:wire_trace.end(token)
  a,b,c=[translate(i) for i in range(3)]
  assert [len(p['messages']) for p in calls]==[2,4,6]
  assert calls[1]['messages'][0]==calls[0]['messages'][0]
  assert 'H01\nEN:' not in calls[0]['messages'][1]['content']
  assert calls[1]['messages'][1]==calls[0]['messages'][1]
  assert 'H01\nEN:' not in calls[1]['messages'][-1]['content']
  assert calls[2]['messages'][:4]==calls[1]['messages']
  assert calls[1]['messages'][2]=={'role':'assistant','content':'<<TP_P0:สวัสดี>>'}
  for i,res in enumerate([a,b,c]):
   e=res['meta']['conversation'];assert e['historyTurns']==i and e['commitStatus']=='committed',e
   assert e['bootstrapExamplesIncluded'] is False,e
   assert e['bootstrapExamplesPersisted'] is False,e
   assert res['meta']['usage']['totalTokens']==3010,'do not subtract cache from input/total'
   folder=Path(temp)/'wire'/wire_trace.folder_name({'traceId':'conversation','operationId':f'conversation-http-{i}'})
   native=json.loads((folder/'04_provider_request.json').read_text())['body'];assert native==calls[i]
   assert json.loads((folder/'03_conversation_path.json').read_text())==e
   assert json.loads((folder/'06_parsed_records.json').read_text())['meta']['conversation']==e
   assert not any(k in native for k in ('conversation','previous_response_id','history','translationMode'))
   text='\n'.join(p.read_text() for p in folder.iterdir() if p.is_file())
   assert 'PRIVATE_ACCOUNT' not in text
  # Same process retains transcript; a fresh store never restores disk state.
  db=store()
  with db.wakeup:
   rows=list(db._rows.values())
  assert len(rows)==1 and rows[0]['revision']==3
  assert len(rows[0]['history'])==3
  fresh=Store(Path(temp)/'state.sqlite')
  assert not fresh._rows
  assert not (Path(temp)/'state.sqlite').exists()
  # Complete runs:API stage uses same translation path and keeps output geometry contract.
  p={'context':{'page_url':'runsapi-doc','tp_tab_session':'owner'},'metadata':{'image_id':'img'},'ai':{'provider':'huggingface','api_key':'PRIVATE_ACCOUNT','base_url':'https://router.huggingface.co/v1','model':'fixture','source_lang':'en','translation_mode':'conversation','conversation':{'reset':'0'},'model_capabilities':cfg.model_capabilities}}
  api_cfg=job_config.build_ai_config(p,'lens_text','ai');assert api_cfg.translation_mode=='conversation'
  tree={'paragraphs':[{'text':'Hello API','items':[]}]}
  canon={'schema':'tp.canonical-original-tree/1','coverage':{'complete':True},'paragraphs':[{'id':'p0','text':'Hello API','source':{'contract':'tp.ai-source-members/1','rawParagraphIndices':[0],'documentParagraphIds':['p0']}}]}
  # Rendering alone is replaced; canonical input, conservation, stage ownership,
  # normal translator, provider invocation and decoding all run as production.
  with patch.object(ai_stage,'build_ai_tree',return_value={'paragraphs':[]}),patch.object(ai_stage,'patch_ai_tree',return_value={'paragraphs':[]}),patch.object(ai_stage,'render_tree_overlay',return_value=''):
   for page in range(2):
    api_cfg.conversation={**api_cfg.conversation,'pageId':f'img-{page}','pageIndex':page}
    out={};ai_stage.run_ai_layer(out,tree,tree,api_cfg,'th',100,100,'','',ai_source_tree=canon)
  assert [len(x['messages']) for x in calls[-2:]]==[2,4],'runs:API also appends old answer'
  # API-owned cross-page ready data goes through the real original HF adapter
  # and HTTP/SSE. First is deliberately held by the test server, not batching code.
  from backend.ai.translation_paths import ready_batch
  batch_cfgs=[replace(cfg,conversation=descriptor({'documentId':'ready-http','pageId':f'p{i}','pageIndex':i},context={'tp_tab_session':'ready-user'})) for i in range(4)]
  for config in batch_cfgs:ready_batch.reserve(config,'th')
  def ready(config,texts):return ready_batch.translate_ready(texts,'th',config,admission_identity='ready-user',cancel_check=lambda:False)
  before_batch=len(calls)
  with ThreadPoolExecutor(3) as pool:
   f=pool.submit(ready,batch_cfgs[0],['SLOW_SOURCE','Hello'])
   assert first_seen.wait(3)
   fs=[pool.submit(ready,batch_cfgs[i],[f'Page {i} A',f'Page {i} B']) for i in (1,2)]
   deadline=time.monotonic()+2
   while any(c._ready_ticket.units is None for c in batch_cfgs[1:3]) and time.monotonic()<deadline:time.sleep(.001)
   release.set();batch_results=[f.result(4),*[f.result(4) for f in fs]]
  assert len(calls)==before_batch+2,'three ready pages use two generations'
  assert batch_results[1]['meta']['conversation']['pageCount']==2
  assert batch_results[1]['meta']['usage']['generations'][0]['receiptId']==batch_results[2]['meta']['usage']['generations'][0]['receiptId']
  tail=ready(batch_cfgs[3],['Final A','Final B'])
  bs=calls[before_batch:]
  assert [len(x['messages']) for x in bs]==[2,4,6]
  assert bs[1]['messages'][0]==bs[0]['messages'][0]
  assert 'H01\nEN:' not in bs[0]['messages'][1]['content']
  assert bs[1]['messages'][1]==bs[0]['messages'][1]
  assert 'H01\nEN:' not in bs[1]['messages'][-1]['content']
  assert bs[2]['messages'][:4]==bs[1]['messages']
  assert bs[1]['messages'][2]['content']=='<<I1_P0:สวัสดี>>\r\n<<I1_P1:สวัสดี>>'
  assert 'ขอบเขตภาพ' not in bs[1]['messages'][-1]['content']
  assert bs[1]['messages'][-1]['content'].startswith('<<I2_P0:')
  assert 'ข้อความต้นฉบับ' not in bs[1]['messages'][-1]['content']
  assert tail['meta']['conversation']['historyTurns']==2
  assert all(len(markers.extract_paragraphs_exact(r['aiTextFull'],2)[0])==2 for r in batch_results+[tail])
  assert len(calls)==before_batch+3,'no generated warmup or repair call added'
  first_seen.clear();release.clear()
  # Same-document waiting occurs BEFORE scarce admission; another document
  # and another user continue, while no warm-up call gets manufactured.
  async def admission():
   gate=AdmissionGate(2,max_waiters=16,max_wait_sec=3);pool=ThreadPoolExecutor(4)
   def ctx(name,config):return NS(trace_id='',payload={'operationId':name},marked=markers.apply([name]),target_lang='th',config=config,request=NS(app=NS(state=NS(ai_admission_gate=gate,ai_executor=pool))),identity=config.conversation['owner'],correlation={},resolved_provider='huggingface',rate={'enabled':False},unlimited=False)
   conf=replace(cfg,conversation=descriptor({'documentId':'serial'},context={'tp_tab_session':'serial-user'}))
   other=replace(conf,conversation=descriptor({'documentId':'another'},context={'tp_tab_session':'other-user'}))
   before=len(calls)
   try:
    first=asyncio.create_task(provider_execution.run(ctx('SLOW_SOURCE',conf),rate_wait_ms=0));assert await asyncio.to_thread(first_seen.wait,3)
    second=asyncio.create_task(provider_execution.run(ctx('NEXT_SOURCE',conf),rate_wait_ms=0))
    third=asyncio.create_task(provider_execution.run(ctx('OTHER_SOURCE',other),rate_wait_ms=0))
    r3=await asyncio.wait_for(third,3);assert not first.done() and not second.done()
    assert r3.result['meta']['conversation']['historyTurns']==0
    assert gate.stats().running==1,'only active predecessor holds admission, not its waiting follower'
    release.set();r1,r2=await asyncio.wait_for(asyncio.gather(first,second),4)
    assert r2.result['meta']['conversation']['historyTurns']==1
    assert r2.result['meta']['conversation']['queueWaitMs']>0
    assert len(calls)==before+3,'three tasks = three generations'
    assert gate.stats().running==0
   finally:release.set();pool.shutdown(wait=True)
  asyncio.run(admission())
  print(json.dumps({'checks':39,'httpRequests':len(calls),'extraWarmup':0,'engines':['runs:Extension API boundary','runs:API ai_stage'],'historyOnWire':[2,4,6],'crossPageBatchUnits':[2,4,2],'scope':'real HTTP/SSE, fake model output; not a live provider benchmark'}))
finally:release.set();server.shutdown();server.server_close()
