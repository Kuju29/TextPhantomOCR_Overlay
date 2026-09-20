"""Independent all-registry stream callback fixture; no paid/live services."""
import json
import runpy
import sys
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
import httpx
from backend.ai import content_stream
h=runpy.run_path(str(ROOT/'scripts/test-api-provider-boundary-matrix.py'),run_name='helpers')
registry=list(h['compose_providers'](h['ProviderRegistry']()))
A='<<I1_P0:คำแปลหนึ่ง>>'; B='<<I2_P0:คำแปลสอง>>'
class Response(h['StreamResponse']):
 def __init__(self,lines):
  super().__init__(lines);self.request=httpx.Request('POST','https://fixture.invalid');self.headers={}
class Client:
 _textphantom_streaming=True
 provider=''; calls=[];seen=[]
 def __init__(self,*a,**kw):pass
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def close(self):pass
 def stream(self,method,url,**kw):
  Client.calls.append(kw['json'])
  p=Client.provider
  if p=='gemini':
   frames=[{'candidates':[{'content':{'parts':[{'text':A}]}}]}, {'candidates':[{'content':{'parts':[{'text':B}]},'finishReason':'STOP'}]}, {'usageMetadata':{'promptTokenCount':23,'candidatesTokenCount':7,'totalTokenCount':30}}]
  elif p=='anthropic':
   frames=[{'type':'message_start','message':{'id':'fixture','usage':{'input_tokens':23,'output_tokens':0}}},{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}, {'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':A}}, {'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':B}}, {'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':7}},{'type':'message_stop'}]
  elif p=='ollama':
   frames=[{'message':{'content':A},'done':False},{'message':{'content':B},'done':False},{'message':{'content':''},'done':True,'done_reason':'stop','prompt_eval_count':23,'eval_count':7}]
  else:
   frames=[{'choices':[{'delta':{'content':A},'finish_reason':None}]},{'choices':[{'delta':{'content':B},'finish_reason':None}]},{'choices':[{'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':23,'completion_tokens':7,'total_tokens':30}}]
  def lines():
   for frame in frames:
    # Before B or terminal is offered, A must already reach request callback.
    raw=json.dumps(frame,ensure_ascii=False)
    if B in raw: assert Client.seen==[A],(p,'A buffered until B',Client.seen)
    if p=='ollama':yield raw
    else:yield 'data: '+raw;yield ''
   if p not in ('gemini','anthropic','ollama'):yield 'data: [DONE]';yield ''
  return Response(lines())
for spec in registry:
 Client.provider=spec.provider_id;Client.calls=[];Client.seen=[]
 req=h['GenerationRequest'](provider=spec.provider_id,model=spec.default_model,api_key='fixture',base_url=spec.default_base_url,system_text='system',user_parts=('<<I1_P0:one>><<I2_P0:two>>',),expected_ids=('I1_P0','I2_P0'),unit_count=2,thinking='off')
 with patch.object(httpx,'Client',Client),content_stream.scope(Client.seen.append), patch('backend.ai.wire_trace.write_json') as writes:
  result=spec.adapter.generate(req)
 metrics=[c.args[1] for c in writes.call_args_list if c.args and c.args[0]=='09_stream_timing.json']
 assert len(metrics)==1,(spec.provider_id,'one timing record')
 assert metrics[0]['contentChunks']==2 and metrics[0]['protocolTerminalMs'] is not None,(spec.provider_id,metrics)
 assert Client.seen==[A,B],(spec.provider_id,Client.seen)
 assert result.text==A+B,(spec.provider_id,result.text)
 assert result.input_tokens==23 and result.output_tokens==7,(spec.provider_id,result.input_tokens,result.output_tokens)
 assert result.terminal_completed is True,(spec.provider_id,'terminal')
 assert len(Client.calls)==1,(spec.provider_id,'extra calls')
 print('PASS',spec.provider_id,'early A before B, exact final text, usage 23/7, terminal, one call')
assert len(registry)==19
print('PASS 19 provider registry adapters with real stream readers and fixture HTTP')
