"""HF production catalogue -> selected route -> planner/probe evidence tests.
Only the upstream HTTP socket is mocked. No real generation or user key.
"""
from pathlib import Path
import sys,json,time,threading,copy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from backend.ai.providers import cloud_huggingface as hf
from backend.ai.providers import huggingface_catalogue as cat, huggingface_details as detail
from backend.ai import provider_resolution as resolution
from backend.ai.translation_paths.batch_policy import select_rows
from backend.ai.translation.contracts import AiConfig
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import compose_providers
compose_providers()
checks=[]
def ck(name,condition):
 assert condition,name
 checks.append(name)
base=hf.DEFAULT_BASE_URL;model='company/model';key='hf_fixture_A'
card={'id':model,'architecture':{'input_modalities':['text','image'],'output_modalities':['text']},
      'providers':[{'provider':'baseten','status':'live','context_length':65536},
                   {'provider':'featherless-ai','status':'live'}]}
real_client=httpx.Client; calls=[];current=copy.deepcopy(card);delay=0;status=200

def handler(request):
 global current
 calls.append({'method':request.method,'url':str(request.url),'key':request.headers.get('authorization')})
 if delay:time.sleep(delay)
 if request.url.path.endswith('/models'):
  return httpx.Response(200,json={'data':[current]})
 return httpx.Response(status,json=current)

def client(*a,**kw):
 kw['transport']=httpx.MockTransport(handler)
 return real_client(*a,**kw)

def clear():
 resolution.forget_model_capabilities('huggingface',base,key)
 detail.discard_account(base,key);calls.clear()

with patch.object(httpx,'Client',client):
 clear()
 listed=hf.ADAPTER.list_models(api_key=key,base_url=base)
 ck('base choice retained first',listed.models[0]==model)
 ck('documented routing choices are explicit',set(listed.models)=={model,*[model+':'+s for s in ['fastest','cheapest','preferred','baseten','featherless-ai']]})
 ck('one GET only for whole catalogue',len(calls)==1 and calls[0]['method']=='GET')
 ck('Auto does not borrow one upstream context','limits' not in listed.capabilities[model])
 ck('explicit baseten uses its own context',listed.capabilities[model+':baseten']['limits']['contextTokens']==65536)
 ck('explicit unknown stays unknown','limits' not in listed.capabilities[model+':featherless-ai'])
 ck('policy is not pinned provider',listed.capabilities[model+':fastest']['hf_route']['provider']=='')
 ck('missing numeric evidence diagnosed',listed.capabilities[model]['hf_route']['missingLimitProviders']==['featherless-ai'])
 for s in ['',':fastest',':cheapest',':preferred',':baseten']:
  req=type('Req',(),{'model':model+s})()
  wire,affinity=hf._effective_conversation_model(req)
  ck('unchanged requested route '+s,wire==model+s)
  ck('only real explicit provider has affinity '+s,affinity==('baseten' if s==':baseten' else ''))
 resolution.remember_model_capabilities('huggingface',base,key,dict(listed.capabilities),models=listed.models)
 proof={'reasoning':{'supported':True,'control':'levels','supported_efforts':['none']}}
 resolution.remember_selected_model_capability('huggingface',base,key,model+':baseten',proof)
 resolution.remember_model_capabilities('huggingface',base,key,dict(listed.capabilities),models=listed.models)
 ck('explicit route Thinking survives list refresh',resolution.model_capabilities('huggingface',base,model+':baseten',key)['reasoning']['supported_efforts']==['none'])
 ck('Thinking never bleeds to another route','reasoning' not in resolution.model_capabilities('huggingface',base,model+':fastest',key))
 ck('Thinking never bleeds to another account','reasoning' not in resolution.model_capabilities('huggingface',base,model+':baseten','hf_B'))
 # Fill missing metadata at the documented SINGLE-MODEL endpoint, not Hub config.
 current['providers'][1]['context_length']=32768
 fresh,caps=resolution.refresh_hf_selected_metadata('huggingface',base,model,key)
 ck('selected detail supplies safe minimum',fresh and caps['limits']['contextTokens']==32768)
 ck('exact model detail URL requested',calls[-1]['url']==base+'/models/'+model)
 n=len(calls)
 for _ in range(12):resolution.refresh_hf_selected_metadata('huggingface',base,model,key)
 ck('no repeated metadata reads per page/turn',len(calls)==n)
 # Exact policy aliases see the same fresh base detail, never base Thinking.
 ck('policy suffix retains modality and common limit',resolution.model_capabilities('huggingface',base,model+':preferred',key)['limits']['contextTokens']==32768)
 ck('pinned route ignores smaller other route',resolution.model_capabilities('huggingface',base,model+':baseten',key)['limits']['contextTokens']==65536)
 # Use production server planner with server-owned selected metadata.
 ai=AiConfig(provider='huggingface',model=model,api_key=key,base_url=base,thinking='default',source_lang='en',memory_mode='off',output_contract='compact_markers_v1')
 rows=[{'ticket':owner,'index':i,'text':'Hello there, good morning.'} for owner in [object() for _ in range(16)] for i in range(10)]
 selected,estimate,_=select_rows(rows,ai,'th',{})
 ck('metadata reaches real planner 160 units',len(selected)==160)
 ck('planner target stays application bounded',estimate['target']==7372)
 # Cross-account independent GET with different returned card; no key/history sharing.
 current=copy.deepcopy(card);current['providers'][0]['context_length']=4096;current['providers'][1]['context_length']=8192
 detail.refresh(base,'hf_B',model)
 ck('other account has its own numeric metadata',cat.selection_capabilities(detail.peek(base,'hf_B',model),model)['limits']['contextTokens']==4096)
 ck('first account metadata unchanged',resolution.model_capabilities('huggingface',base,model,key)['limits']['contextTokens']==32768)
 # Multiple simultaneous readers for a cold account coalesce to one GET.
 detail.discard_account(base,'hf_concurrent');calls.clear();delay=.06
 with ThreadPoolExecutor(max_workers=16) as pool:
  results=list(pool.map(lambda _:detail.refresh(base,'hf_concurrent',model),range(16)))
 delay=0
 ck('16 readers share one metadata GET',len(calls)==1 and all(r['limits']['contextTokens']==4096 for r in results))
 # Invalid/ambiguous/partial data never manufactures a larger window.
 for label,changed in [('wrong-model',{**card,'id':'other/model'}),('missing-limit',card),('duplicate',{**card,'providers':[card['providers'][0],card['providers'][0]]})]:
  current=copy.deepcopy(changed);detail.discard_account(base,key)
  r=detail.refresh(base,key,model)
  ck(label+' never claims auto context','contextTokens' not in r.get('limits',{}))
 status=503;detail.discard_account(base,key);calls.clear()
 ck('metadata outage remains unknown',detail.refresh(base,key,model)=={})
 for _ in range(10):detail.refresh(base,key,model)
 ck('metadata error negative cache avoids stampede',len(calls)==1)
 status=200;calls.clear()
 for endpoint,m in [('https://other.invalid/v1',model),(base,'../secret'),(base,'company/../../secret'),(base,'https://other.test/model')]:
  ck('metadata endpoint/id bounded '+m,detail.refresh(endpoint,key,m)=={})
 ck('no token sent to arbitrary metadata endpoint',not calls)
 # Auto/schema/prompt/cache are untouched; routing knowledge never claims a hit.
 ck('all network requests were GET',all(c['method']=='GET' for c in calls))
from backend.ai.providers.huggingface_catalogue import add_explicit_choices
from backend.ai.provider_resolution import normalize_model_capabilities
ck('missing model list is harmless',add_explicit_choices([],None,{}, {}) == ())
ck('malformed diagnostic lists are ignored',normalize_model_capabilities({'hf_route':{
 'policy':'fastest','liveProviders':None,'missingLimitProviders':{}}})['hf_route']['liveProviders']==[])
print(json.dumps({'checks':len(checks),'passed':checks,'scope':'HF socket mocked; real adapters, model cache and planner; no AI generation'},ensure_ascii=False,indent=2))
