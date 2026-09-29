"""Exact model contract -> minimum resolution -> native payload. No live calls."""
from pathlib import Path
from dataclasses import replace
import sys,json,subprocess
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.providers import cloud_openai,cloud_anthropic
from backend.ai.providers.openai_reasoning import reasoning_capability
from backend.ai.providers.anthropic_reasoning import _reasoning_capability,_apply_reasoning
from backend.ai.provider_contract import GenerationRequest,ProbeRequest,ProbeResponse
from backend.ai.reasoning_preference import resolve_reasoning_preference
from backend.ai.cloud_reasoning import ensure_cloud_reasoning_preflight
count=0
for model,minimum in [('gpt-4o','default'),('gpt-4.1-mini','default'),('gpt-5','minimal'),('gpt-5.1','off'),('gpt-5.2','off'),('gpt-5.6-luna','off'),('gpt-5.6-terra','off'),('gpt-5.6-sol','off'),('gpt-5.6','off')]:
    cap=reasoning_capability(model);assert cap
    selected=resolve_reasoning_preference('minimum',cap);assert selected==minimum
    ensure_cloud_reasoning_preflight('openai',model,'minimum',selected,cap,capability_verified=True)
    req=GenerationRequest(provider='openai',model=model,system_text='Translate. Markers only.',user_parts=('<<TP_P1:Hello.>>',),thinking=selected)
    body=cloud_openai.prepare_payload(req);assert body['model']==model
    if cap['supported']:
        assert body['reasoning_effort']==('none' if minimum=='off' else minimum)
        assert 'max_completion_tokens' in body and 'max_tokens' not in body
        for effort in cap['supported_efforts']:
            body=cloud_openai.prepare_payload(replace(req,thinking='off' if effort=='none' else effort))
            assert body['reasoning_effort']==effort
            count+=1
    else:
        assert 'reasoning_effort' not in body and 'max_tokens' in body
    with patch.object(cloud_openai,'openai_chat_probe',return_value=ProbeResponse(True,200)) as probe:
        found=cloud_openai.ADAPTER.probe(ProbeRequest(model=model,api_key='fixture',base_url=cloud_openai.DEFAULT_BASE_URL))
        assert found.capabilities['reasoning']==cap and probe.call_count==1
    count+=5
for model in ('claude-sonnet-4-20250514','claude-3-7-sonnet-20250219','claude-haiku-4-5-20251001','claude-opus-4-1'):
    cap=_reasoning_capability(model);assert cap['control']=='toggle'
    ensure_cloud_reasoning_preflight('anthropic',model,'on','on',cap,capability_verified=True)
    body={'model':model,'max_tokens':2048};assert _apply_reasoning(body,model,'on')=='requested_manual_minimum'
    assert body['thinking']=={'type':'enabled','budget_tokens':1024}
    assert 'output_config' not in body
    assert cloud_anthropic.MODEL_ALIASES.get(model,model)==model
    _apply_reasoning(body,model,'off');assert body['thinking']=={'type':'disabled'}
    count+=6
for model in ('claude-sonnet-4-6','claude-opus-4-7'):
    cap=_reasoning_capability(model);assert cap['control']=='levels'
    for effort in cap['supported_efforts']:
        body={'max_tokens':2048};_apply_reasoning(body,model,'off' if effort=='none' else effort)
        if effort=='none':assert body['thinking']=={'type':'disabled'}
        else:assert body['thinking']=={'type':'adaptive'} and body['output_config']['effort']==effort
        count+=1
# Pass normalized native catalogue metadata through the production JavaScript
# picker: a Python toggle without an explicit On must not hide On in the UI.
from backend.ai.provider_resolution import normalize_model_capabilities
caps=[normalize_model_capabilities({'reasoning':_reasoning_capability(m)})['reasoning'] for m in
      ('claude-sonnet-4-20250514','claude-haiku-4-5','claude-opus-4-5')]
module=(Path(__file__).resolve().parents[1]/'src/shared/reasoning-preference.js').as_uri()
js=f"import {{reasoningOptionsForCapability}} from {json.dumps(module)}; import fs from 'node:fs'; console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(c=>reasoningOptionsForCapability(c).map(x=>x.value))))"
ui=json.loads(subprocess.check_output(['node','--input-type=module','-e',js],input=json.dumps(caps).encode()))
assert all(options==['minimum','off','on'] for options in ui),ui
for model in ('gpt-unknown-future','gpt-5.999','o3-unknown-new'):
    assert reasoning_capability(model)=={}
assert _reasoning_capability('claude-future-unknown')=={}
print(f'PASS {count} native reasoning assertions: OpenAI documented controls/probe preservation and Anthropic manual/adaptive separation; unknown remains unknown')
