"""Live invocation code with mocked provider adapters; no external AI requests."""
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.prompts.styles import select_style
from backend.ai.prompts.instruction_packs import instruction_pack
from backend.ai.prompts.builder import build_static_user_prefix, build_translator_identity_system
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig
from backend.ai.resolve import prompt_default
from backend.ai.request_diagnostics import request_diagnostics
from backend.diagnostic_schema import sanitize_prompt_layout

assert hashlib.sha256((ROOT/'api/backend/ai/prompts/builtin_styles.py').read_bytes()).hexdigest() == 'afc53060d11779aadb89d91fdc9258c98465f0a56de6cb1a92e8e4d5d336c1ef', '13.1 built-in styles must remain unchanged'
checks = 0
providers = list(invocation.provider_registry)
with tempfile.TemporaryDirectory(prefix='tp-user-style-') as tmp, patch.dict(os.environ, {'TP_USAGE_STATE_FILE':str(Path(tmp)/'usage.sqlite')}):
    for spec in providers:
        for lang, answer in [('th','สวัสดี'),('en','Hello'),('ja','こんにちは')]:
            for repair in (False,True):
                selected = 'USER_STYLE_SENTINEL 😀' if repair else ''
                cfg = AiConfig(provider=spec.provider_id, model='fixture-model', api_key='' if spec.local else 'fixture-secret',
                    base_url=spec.default_base_url, prompt_editable=selected, thinking='off', char_memory=False,
                    source_lang='en', style_examples=not repair, memory_mode='off',
                    repair_reason='wrong_target_script' if repair else '',
                    page_context=[{'id':'neighbor','text':'NEIGHBOR_CONTEXT_SENTINEL'}])
                captured=[]
                def generate(request):
                    captured.append(request)
                    text=json.dumps({'P0':answer},ensure_ascii=False) if request.response_schema else f'<<TP_P0:{answer}>>'
                    return ChatResult(text=text,used_model='fixture-model',input_tokens=500,output_tokens=7,total_tokens=507,
                        finish_reason='stop',terminal_completed=True,terminal_evidence='provider_done',thinking_applied='requested_off_unverified')
                with patch.object(spec.adapter,'generate',side_effect=generate), patch.object(invocation,'assert_ai_base_url_allowed'), patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})):
                    result=invocation._translate_once(markers.apply(['Hello']),lang,cfg,is_retry=repair)
                assert len(captured)==1
                request=captured[0];style,_=select_style(lang,selected)
                assert request.system_text == build_translator_identity_system(style,lang)
                assert request.system_text.count(style)==1
                assert len(request.user_parts)==1 and request.user_parts[0].count(style)==0
                assert request.expected_ids==('P0',) and request.thinking=='default'
                user=request.user_parts[0]
                assert 'NEIGHBOR_CONTEXT_SENTINEL' in user
                assert (instruction_pack(lang)['examplesHeading'] in user) is (not repair)
                assert user.endswith(instruction_pack(lang)['sourceHeading']+'\n'+ ('P0:Hello' if request.response_schema else '<<TP_P0:Hello>>'))
                layout=result['meta']['promptLayout']
                assert layout['styleRole']=='system' and layout['systemStyleCopies']==1 and layout['userStyleCopies']==0
                assert layout['styleSha256']==hashlib.sha256(style.encode()).hexdigest()
                prefix=build_static_user_prefix(lang,source_lang='en',structured_output=bool(request.response_schema),style_examples=not repair,selected_style=style)
                assert layout['staticPrefixSha256']==hashlib.sha256((request.system_text+'\0'+prefix).encode()).hexdigest()
                assert result['meta']['prompt_audit']['styleRole']=='system'
                assert result['meta']['prompt_audit']['effectiveStyleChars']==len(style)
                assert sanitize_prompt_layout(layout)==layout
                diag=request_diagnostics({'promptLayout':layout})
                assert diag['instructionLayout']['styleRole']=='system'
                assert diag['inputActual'] is None and diag['cache']['status']=='not_reported'
                checks+=1
for lang in ['th','en','ja','fr']:
    default=prompt_default(lang,want_memo=False)
    assert default['system_text']==build_translator_identity_system(select_style(lang)[0],lang)
    assert default['system_base']==default['system_text']
    assert default['styleRole']=='system'
    assert default['canonicalPrompt']['styleRole']=='system'
    assert default['prompt_editable_default']==select_style(lang)[0]
print(json.dumps({'checks':checks,'providers':len(providers),'defaultEndpoints':4,'style13_1':'byte_identical',
                  'scope':'API invocation + mapping metadata; mocked adapters; no external requests'},ensure_ascii=False))
