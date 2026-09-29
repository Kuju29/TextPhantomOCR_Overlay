"""History stays in native messages/contents across the supported adapter matrix."""
import copy,runpy,sys
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'api'))
h=runpy.run_path(str(ROOT/'scripts/test-api-provider-boundary-matrix.py'),run_name='helpers')
registry=list(h['compose_providers'](h['ProviderRegistry']()))
Client=h['BoundaryClient'];NativeClient=h['NativeLmStudioClient'];Response=h['Response'];gemini=h['cloud_gemini'];anthropic=h['cloud_anthropic']
prior=({'role':'user','text':'TASK_KEEP_ONCE\n<<I1_P0:A_OLD_SOURCE>>'}, {'role':'assistant','text':'<<I1_P0:B_OLD_ANSWER>>'})
count=0
for spec in registry:
 expected_transport = "native_response_cursor" if spec.provider_id == "lmstudio" else "message_replay"
 assert spec.conversation_transport == expected_transport, (
  spec.provider_id, spec.conversation_transport, expected_transport)
 if spec.provider_id == 'lmstudio':
  # Independent native chat owns no state and rejects an injected history;
  # linked Conversation is covered by the native cursor suite.
  NativeClient.calls=[]
  req=h['GenerationRequest'](provider='lmstudio',model=spec.default_model,api_key='fixture',
    base_url=spec.default_base_url,system_text='SYSTEM_SAME',
    user_parts=('<<I2_P0:C_CURRENT_SOURCE>>',),unit_count=1,
    expected_ids=('I2_P0',),thinking='default',
    cache_context={'translationMode':'independent'})
  with patch.object(h['openai_chat'].httpx,'Client',NativeClient):
   answer=spec.adapter.generate(req)
   try:spec.adapter.generate(replace(req,history_messages=prior))
   except ValueError as exc:assert 'cannot send conversation history' in str(exc)
   else:raise AssertionError('LM Studio Independent accepted injected old history')
  assert answer.provider_response_id==''
  assert len(NativeClient.calls)==1,NativeClient.calls
  body=NativeClient.calls[0]['json']
  assert body['store'] is False and 'previous_response_id' not in body
  assert body['system_prompt']=='SYSTEM_SAME' and body['input']==req.user_parts[0]
  count+=1
  print('PASS lmstudio stateless native chat sends current input only; old history refused')
  continue
 def dispatch(request):
  captured=[];Client.calls=[]
  def gpost(*args,**kw):
   captured.append(args[2]);return Response({'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':h['ANSWER']}]}}], 'usageMetadata':{'promptTokenCount':23,'candidatesTokenCount':7,'totalTokenCount':30}})
  def apost(*args,**kw):
   captured.append(kw['json']);return Response({'content':[{'type':'text','text':h['ANSWER']}],'stop_reason':'end_turn','usage':{'input_tokens':23,'output_tokens':7}})
  with ExitStack() as stack:
   stack.enter_context(patch.object(h['openai_chat'].httpx,'Client',Client));stack.enter_context(patch.object(gemini,'_post_once',side_effect=gpost));stack.enter_context(patch.object(anthropic,'post_json',side_effect=apost))
   answer=spec.adapter.generate(request)
  captured += [x['json'] for x in Client.calls if x['method']=='POST'];assert len(captured)==1,(spec.provider_id,len(captured))
  return captured[0]
 # This fixture tests history, not account-verified Thinking controls. The
 # generic local adapters need an explicit Provider default selection here;
 # their unsupported Off/Lowest cases have separate pre-dispatch tests.
 selected_thinking = 'default' if spec.local else 'off'
 req=h['GenerationRequest'](provider=spec.provider_id,model=spec.default_model,api_key='fixture',base_url=spec.default_base_url,system_text='SYSTEM_SAME',user_parts=('<<I2_P0:C_CURRENT_SOURCE>>',),unit_count=1,expected_ids=('I2_P0',),thinking=selected_thinking)
 a=dispatch(req);b=dispatch(replace(req,history_messages=prior))
 native=b.get('messages',b.get('contents'))
 assert native is not None,spec.provider_id
 roles=[m['role'] for m in native]
 if spec.provider_id=='gemini':assert roles==['user','model','user'],roles
 elif spec.provider_id=='anthropic':assert roles==['user','assistant','user'],roles
 else:assert roles==['system','user','assistant','user'],roles
 flattened=str(native)
 assert flattened.count('I1_P0')==2 and flattened.count('I2_P0')==1 and flattened.count('A_OLD_SOURCE')==1 and flattened.count('B_OLD_ANSWER')==1 and flattened.count('C_CURRENT_SOURCE')==1
 assert native[-1]==a.get('messages',a.get('contents'))[-1],spec.provider_id
 # All top-level native provider controls are unchanged; history adds only
 # message entries, not a synthetic session or unsupported persistence flag.
 aa=copy.deepcopy(a);bb=copy.deepcopy(b)
 for k in ('messages','contents'):aa.pop(k,None);bb.pop(k,None)
 assert aa==bb,(spec.provider_id,aa,bb)
 assert 'previous_response_id' not in b and 'translationMode' not in b
 count+=1
 print('PASS',spec.provider_id,'native history roles, exact current input, no extra call/control')
print(f'PASS {count} adapters: 17 replay roles/current IDs; LM Studio Independent stateless native/current only')
