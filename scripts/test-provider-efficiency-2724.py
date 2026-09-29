"""Regression evidence for all Cloud routes; native HTTP matrix is separate.
No network/models/keys are used. Tests production catalogue, planner, decoder,
Conversation admission/history and provider-owned request construction.
"""
from pathlib import Path
import sys, json, uuid, copy
from dataclasses import replace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from backend.ai.providers import compose_providers, cloud_huggingface
from backend.ai.provider_registry import provider_registry
from backend.ai.providers.huggingface_limits import catalogue_limits
from backend.ai.translation_paths.batch_policy import select_rows
from backend.ai.translation_paths.mode import descriptor
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.clients.base import ChatResult
from backend.ai import markers
from backend.ai.markers.decode import _decode_strict_records
from backend.ai.workload import WorkloadBudgetError
registry=compose_providers()
cloud=[p for p in registry if not p.local and p.provider_id!='paid']
assert len(cloud)==9
checks=0

def require(ok, label):
    global checks
    assert ok, label
    checks+=1

def entry(p,c=131072,**extra):
    return {'provider':p,'context_length':c,'status':'live',**extra}

for entries,expect,route_count in [
    ([entry('a',131072),entry('b',65536)],65536,2),
    ([entry('a',131072),entry('b',None)],None,1),
    ([entry('a',131072),entry('a',131072)],None,0),
    ([entry('a',131072),entry('b',True)],None,1),
    ([entry('a',131072),entry('b',-1)],None,1),
    ([entry('a',131072),entry('not a provider',65536)],None,1),
    ([entry('a',131072),entry('b',65536,status='staging')],131072,1),
    ([],None,0),
    ([entry('a',4096)],4096,1),
]:
    routes,common=catalogue_limits(entries)
    require(common.get('contextTokens')==expect,('HF common',entries,common))
    require(len(routes)==route_count,'HF per-route isolation')
body={'data':[{'id':'company/model','providers':[entry('a',131072),entry('b',65536)]},
              {'id':'company/incomplete','providers':[entry('a'),entry('b',None)]}]}
class ModelClient:
    def __init__(self,*a,**k):pass
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def get(self,url,**k):
        return httpx.Response(200,json=body,request=httpx.Request('GET',url))
with patch.object(cloud_huggingface.httpx,'Client',ModelClient):
    listed=cloud_huggingface.ADAPTER.list_models(api_key='fixture',base_url='https://fixture.invalid/v1')
require(listed.capabilities['company/model']['limits']['contextTokens']==65536,'actual HF adapter exports intersection')
require(listed.capabilities['company/model']['provider_limits']['a']['contextTokens']==131072,'pin retains its own limit')
require('limits' not in listed.capabilities['company/incomplete'],'missing fallback route stays unknown')
# No explicit suffix is injected by new limits: still Auto fastest/failover.
require(listed.candidates['company/model']['routingPolicy']=='hf_auto_fastest_failover','HF routing unchanged')

owners=[object() for _ in range(16)]
rows=[{'ticket':owner,'index':i,'text':'Hello there, good morning.'} for owner in owners for i in range(10)]
budget_results=[]
for spec in cloud:
    ai=AiConfig(provider=spec.provider_id,model=spec.default_model,api_key='fixture',base_url=spec.default_base_url,
        thinking='default',source_lang='en',memory_mode='off',output_contract='compact_markers_v1',
        model_capabilities={'limits':{'contextTokens':131072},'reasoning':{'supported':False}})
    def plan(caps,profile=None):
        config=replace(ai,model_capabilities=caps)
        with patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(True,caps)):
            return select_rows(rows,config,'th',profile or {})
    known,estimate,_=plan(ai.model_capabilities)
    unknown,old,_=plan({'reasoning':{'supported':False}})
    require(len(known)>len(unknown),(spec.provider_id,'known window still fragmented'))
    require(estimate['target']==7372,(spec.provider_id,'common 8K budget',estimate))
    require(len(known)%10==0,'whole pages')
    small,sm,_=plan({'limits':{'contextTokens':131072,'maxOutputTokens':2048},'reasoning':{'supported':False}})
    require(sm['target']<=2048 and len(small)<len(known),'true small output cap wins')
    _,retry,_=plan(ai.model_capabilities,{'outcomes':['length']})
    require(retry['target']<estimate['target'],'recent truncation margin')
    budget_results.append({'provider':spec.provider_id,'unknownUnits':len(unknown),'knownUnits':len(known),'target':estimate['target']})

    calls=[]
    def generate(req):
        calls.append(req)
        answer='\n'.join(f'{markers.record_open(x)}:คำแปล{j}>>' for j,x in enumerate(req.expected_ids))
        if len(calls)==1:answer=answer.replace('>>','>>>',1)
        return ChatResult(text=answer,used_model=req.model,input_tokens=100,output_tokens=20,total_tokens=120,
            thinking_tokens=0,terminal_completed=True,terminal_evidence='provider_done',finish_reason='stop')
    ai=replace(ai,translation_mode='conversation',conversation=descriptor({'documentId':f'test-{uuid.uuid4()}'},
        context={'tp_tab_session':f'owner-{spec.provider_id}'}))
    with patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(True,ai.model_capabilities)), \
         patch.object(spec.adapter,'generate',side_effect=generate):
        results=[]
        for turn in range(1,4):
            config=copy.deepcopy(ai)
            config.conversation['origins']=[{'pageId':f'p{turn}','pageIndex':turn-1,'pageOrder':turn,
                'unitIds':[f'I{turn}_P0',f'I{turn}_P1'],'originalIds':['g0','g1']}]
            results.append(translate(markers.apply(['First source','Second source']),'th',config))
    require(len(calls)==3,'one provider call per turn; no hidden repair/prewarm')
    require([r['meta']['conversation']['historyTurns'] for r in results]==[0,1,2],(spec.provider_id,'history retention'))
    require(all(r['meta']['conversation']['commitStatus']=='committed' for r in results),'all committed')
    require(results[0]['meta']['redundant_closing_delimiter_chars']==1,'formatting telemetry')
    require('>>>' not in str(calls[1].history_messages),'clean only the newly committed turn')
    require(calls[2].history_messages[:2]==calls[1].history_messages,'previous history prefix immutable')
    require('I1_P0' in str(calls[1].history_messages) and 'I1_P1' in str(calls[1].history_messages),'no lost accepted ID')
    require(all(r['meta']['usage']['totalTokens']==120 for r in results),'usage receipt not rewritten')

for text in ['<<TP_P0:ไทย>>>','<<TP_P0:ไทย>>>\r\n<<TP_P1:อีกคำ>>']:
    decoded=_decode_strict_records(text,['P0','P1'])
    require(decoded.redundant_closing_delimiter_chars==1 and decoded.unexpected_prose_chars==0,'single owned closer recovered')
for text in ['<<TP_P0:ไทย>>>>','<<TP_P0:ไทย>>>prose','>\n<<TP_P0:ไทย>>',
             '<<TP_P0:ไทย>> >>','<<TP_P99:ไทย>>>']:
    d=_decode_strict_records(text,['P0','P1'])
    require(d.redundant_closing_delimiter_chars==0,'ambiguous suffix not recovered')
    require(d.unexpected_prose_chars or d.discarded_ids,'malformed prose still diagnosed')
d=_decode_strict_records('<<TP_P0:ไทย>>>\n<<TP_P0:ซ้ำ>>>',['P0'])
require(d.duplicate_ids==('P0',) and d.missing_ids==('P0',),'duplicates never become valid via formatting cleanup')
print(json.dumps({'checks':checks,'cloudProviders':len(cloud),'budgets':budget_results},indent=2))
print('PASS HF complete live-route intersection; 9 provider planners and 3-turn history/usage paths; exact suffix recovery only')
