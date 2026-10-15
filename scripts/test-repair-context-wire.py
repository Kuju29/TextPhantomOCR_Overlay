"""19.18: captured context targets must match the final selected wire contract."""
import copy, hashlib, json, re, sys, time, unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
from backend.ai.prompts.source_context import normalize_source_context
from backend.application.ai_translation.request_validation import build_config
from backend.ai.translation.invocation import _translate_once
from backend.ai.translation_paths.store import execution_scope
from backend.ai.clients.base import ChatResult
from backend.ai import markers
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_contract import ModelListResult, ProbeResponse
from backend.ai.providers.local_openai_runtime import RuntimeContextEvidence
from backend.config import settings

class RepairContextWire(unittest.TestCase):
    def setUp(self):
        # Named Local defaults intentionally require the personal loopback policy.
        prior = settings.ai_endpoint_policy
        object.__setattr__(settings, 'ai_endpoint_policy', 'personal')
        self.addCleanup(lambda: object.__setattr__(settings, 'ai_endpoint_policy', prior))
    def test_explicit_mapping_and_legacy(self):
        units=[{'id':'I12_P4','text':'first'},{'id':'I18_P7','text':'second'}]
        groups=[{'targetIds':['I12_P4','I18_P7','not-in-slice'], 'units':[{'id':'c','text':'captured source'}]}]
        original=copy.deepcopy(groups)
        self.assertEqual(normalize_source_context(groups, units)[0]['targetIds'], ['P0','P1'])
        self.assertEqual(normalize_source_context(groups, units, wire_ids=[u['id'] for u in units])[0]['targetIds'], ['I12_P4','I18_P7'])
        self.assertEqual(normalize_source_context(groups, units[1:], wire_ids=['I18_P7'])[0]['targetIds'], ['I18_P7'])
        self.assertEqual(groups,original)
        for ids in ([], ['I12_P4'], ['I12_P4','I12_P4'], ['', 'I18_P7']):
            with self.assertRaisesRegex(ValueError,'invalid_source_context_mapping'):
                normalize_source_context(groups, units, wire_ids=ids)

    def test_final_provider_request_main_repair_slices_and_legacy(self):
        self.assertEqual(len(provider_registry), 18)  # Custom Local belongs to the Extension only.
        for spec in provider_registry:
            pid=spec.provider_id
            for conversation in (False,True):
                for selected in (['I12_P4','I18_P7'], ['I18_P7']):
                    with self.subTest(provider=pid,conversation=conversation,selected=selected):
                        units=[{'id':uid,'text':'Original source '+uid} for uid in selected]
                        payload={'translationMode':'conversation' if conversation else 'independent',
                            'units':units,'targetLang':'th','sourceLang':'en',
                            'provider':{'id':pid,'model':'fixture-context','baseUrl':spec.default_base_url,'apiKey':'fixture-key','thinking':'off'},
                            'context':{'tp_tab_session':'context-fixture-'+pid},
                            'conversation':{'documentId':'context-fixture-'+pid,'branch':'repair','origins':[
                                {'pageId':'page-'+uid.split('_')[0], 'pageOrder':int(uid.split('_')[0][1:]),
                                 'unitIds':[uid], 'originalIds':['original-'+uid]} for uid in selected]},
                            'repair':{'owner':'extension','enabled':False,'branch':'repair'},
                            'sourceContext':[{'targetIds':['I12_P4','I18_P7'], 'origin':'initial_request',
                                'units':[{'id':'c0','text':'READ ONLY EVIDENCE'}]}]}
                        caps={'reasoning':{'supported':False,'control':'none','supported_efforts':[],'source':'fixture_current_catalogue'},
                            'limits':{'contextTokens':65536,'runtimeContextTokens':65536,'maxOutputTokens':8192,'scope':'runtime','source':'fixture_native_metadata'}}
                        payload['provider']['modelCapabilities']=caps
                        cfg=build_config(payload)
                        requests=[]
                        def generate(req):
                            requests.append(req)
                            answer=json.dumps({uid:'คำแปล' for uid in req.expected_ids}) if req.response_schema else '\n'.join('<<'+(uid if uid.startswith('I') else 'TP_'+uid)+':คำแปล>>' for uid in req.expected_ids)
                            return ChatResult(text=answer,used_model='fixture-context',input_tokens=20,output_tokens=8,total_tokens=28,finish_reason='stop',terminal_completed=True,terminal_evidence='provider_done',provider_response_id='resp_context_fixture' if pid=='lmstudio' and conversation else '')
                        source=markers.apply([row['text'] for row in units])
                        with ExitStack() as stack:
                            stack.enter_context(patch.object(spec.adapter,'generate',side_effect=generate))
                            stack.enter_context(patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(True,caps)))
                            stack.enter_context(patch('backend.ai.provider_resolution.refresh_hf_selected_metadata',return_value=(True,caps)))
                            if pid=='ollama':
                                stack.enter_context(patch.object(spec.adapter,'probe',return_value=ProbeResponse(True,200,capabilities=caps)))
                            if pid=='lmstudio':
                                stack.enter_context(patch.object(spec.adapter,'list_models',return_value=ModelListResult(models=('fixture-context',),status='valid',http_status=200,capabilities={'fixture-context':caps})))
                            if pid in {'vllm','llamacpp','koboldcpp'}:
                                def evidence(**kwargs):
                                    return RuntimeContextEvidence(provider=pid,model=kwargs['model'],base_url=spec.adapter.normalize_base_url(kwargs['base_url']),
                                        key_digest=hashlib.sha256(kwargs['api_key'].encode()).hexdigest(),limits=caps['limits'],issued_at=time.monotonic())
                                stack.enter_context(patch.object(spec.adapter,'inspect_runtime_context',side_effect=evidence))
                            with execution_scope(cfg,'th'):
                                _translate_once(source,'th',cfg,is_retry=True)
                        self.assertEqual(len(requests),1)
                        req=requests[0];user='\n'.join(req.user_parts)
                        targets=[uid for group in re.findall(r'"appliesTo":(\[[^\]]*\])',user) for uid in json.loads(group)]
                        self.assertTrue(targets,user)
                        self.assertEqual(targets,list(req.expected_ids))
                        self.assertEqual(list(req.expected_ids),selected if conversation else [f'P{i}' for i in range(len(units))])

if __name__=='__main__':unittest.main(verbosity=2)
