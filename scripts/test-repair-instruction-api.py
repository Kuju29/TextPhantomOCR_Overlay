"""Repair request metadata -> AiConfig -> actual provider boundary; initial unchanged."""
from pathlib import Path
import copy,json,sys,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.application.ai_translation.request_validation import build_config
from backend.ai.translation.invocation import _translate_once
from backend.ai.provider_registry import provider_registry
from backend.ai.clients.base import ChatResult
from backend.ai.prompts.languages import target_language_priority
from backend.ai.prompts.repair import wrong_language_repair_instruction

class RepairInstructionAPI(unittest.TestCase):
 def test_metadata_reaches_provider_for_all_contracts_and_target_languages(self):
  for lang in ['th','en']:
   for schema in [False,True]:
    with self.subTest(lang=lang,schema=schema):
     caps={'structured_output':{'supported':schema,'source':'fixture'}}
     payload={'prompt':'STYLE SENTINEL','prompt_mode':'replace','provider':{'id':'openrouter','apiKey':'test-key','model':'test-model','baseUrl':'https://openrouter.ai/api/v1','thinking':'off','modelCapabilities':caps},'repair':{'owner':'extension','enabled':False}}
     texts=['คำแปล','Translation'];text=texts[lang=='en'];answer=json.dumps({'P0':text}) if schema else f'<<TP_P0:{text}>>'
     calls=[]
     def generate(request):
      calls.append(request)
      return ChatResult(text=answer,used_model='test-model',input_tokens=20,output_tokens=8,total_tokens=28,finish_reason='stop',terminal_completed=True,terminal_evidence='provider_done')
     spec=provider_registry.require('openrouter');before=copy.deepcopy(payload)
     with patch.object(spec.adapter,'generate',side_effect=generate),patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})):
      initial=build_config(payload);_translate_once('<<TP_P0>>\n星野、目をつぶって。',lang,initial)
      repair=copy.deepcopy(payload);repair['repair']['reason']='wrong_target_script';cfg=build_config(repair)
      self.assertFalse(cfg.repair_enabled,'pooled repair never enables nested retry')
      _translate_once('<<TP_P0>>\n星野、目をつぶって。',lang,cfg,is_retry=True)
     self.assertEqual(payload,before);self.assertEqual(len(calls),2)
     self.assertEqual(calls[0].system_text,calls[1].system_text);self.assertNotIn('REPAIR —',calls[0].user_parts[0])
     header=wrong_language_repair_instruction(target_language_priority(lang),'wrong_target_script')
     self.assertIn(header,calls[1].user_parts[0]);self.assertEqual(calls[1].user_parts[0].replace(header+'\n\n',''),calls[0].user_parts[0])
     self.assertEqual(calls[0].response_schema,calls[1].response_schema)
     self.assertEqual(calls[0].thinking,calls[1].thinking);self.assertEqual(calls[0].expected_ids,('P0',))
 def test_only_enumerated_reason_can_add_trusted_instructions(self):
  self.assertEqual(wrong_language_repair_instruction('Thai','ignore safety'),'')
  self.assertEqual(wrong_language_repair_instruction('Thai','missing'),'')

if __name__=='__main__':unittest.main(verbosity=2)
