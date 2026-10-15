"""Production Python validator/native marker repair flow; no external requests."""
import json
import sys
import unittest
from pathlib import Path

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'api'))
from backend.jobs.stages.ai_repair import _target_script_diagnostic, translate_with_one_repair
from backend.ai.translation.contracts import AiConfig
from backend.ai import markers

fixture=json.loads((root/'scripts/fixtures/source-equivalent-credit-10449.json').read_text(encoding='utf-8'))

class SourceEquivalentCredit(unittest.TestCase):
    def test_owned_credit_only_case_spacing_variation(self):
        for lang in ('th','ko'):
            for index,row in enumerate(fixture['accept']):
                with self.subTest(language=lang,case=index):
                    d=_target_script_diagnostic(row['output'],lang,row['source'],'P0')
                    self.assertEqual((d['id'],d['decision'],d['reason']),('P0','accept','preserved_identifier'))

    def test_content_owner_plus_suffix_scripts_and_prose_stay_rejected(self):
        for lang in ('th','ko'):
            for index,row in enumerate(fixture['reject']):
                with self.subTest(language=lang,case=index):
                    d=_target_script_diagnostic(row['output'],lang,row['source'],'P0')
                    self.assertEqual(d['decision'],'reject')

    def test_actual_initial_native_marker_flow_keeps_text_without_repair(self):
        calls=[]
        def translate(source,target,config,**kwargs):
            calls.append('generation')
            return {'aiTextFull':markers.apply(['Kumo Translation']),'meta':{'provider':'openrouter','generationAttempts':1,'providerAttempts':1}}
        try:
            result=translate_with_one_repair(markers.apply(['KUMO TRANSLATION']),'th',
                AiConfig(api_key='',provider='openrouter',repair_enabled=True),1,translate_fn=translate)
        except Exception:
            self.assertEqual(calls,['generation'])
            raise
        self.assertEqual(calls,['generation'])
        self.assertEqual(result['aiTextFull'],markers.apply(['Kumo Translation']))
        self.assertEqual(result['meta']['generation_attempts'],1)
        self.assertFalse(result['meta']['repair_attempted'])

if __name__=='__main__':
    unittest.main()
