"""Real ingress/job configuration preserves Source .39 non-Paid metadata.

Optional --baseline-archive compares the same calls with the archived .39
functions. No provider is contacted and every credential is synthetic.
"""
import argparse
from dataclasses import asdict
from pathlib import Path
import sys
import types
import unittest
from zipfile import ZipFile

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--baseline-archive', type=Path)
options, arguments = parser.parse_known_args()
sys.argv = [sys.argv[0], *arguments]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.application.ai_translation.request_validation import build_config
from backend.jobs.stages.config import build_ai_config

PROVIDERS = ('openrouter', 'login', 'lmstudio')
LEGACY_UNUSED = ('legacy click 1', 'งาน-เดิม', 'x' * 121,
    {'unused': 'metadata'}, ['legacy'], False, 0, None, '')


class UserRunScope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = {}
        if options.baseline_archive:
            with ZipFile(options.baseline_archive) as archive:
                for key, path in (
                    ('extension', 'api/backend/application/ai_translation/request_validation.py'),
                    ('job', 'api/backend/jobs/stages/config.py'),
                ):
                    module = types.ModuleType('baseline39_' + key)
                    exec(compile(archive.read('TextPhantom/' + path),
                        '<archived-source39-' + key + '>', 'exec'), module.__dict__)
                    cls.baseline[key] = module

    def test_extension_nonpaid_accepts_unused39_metadata(self):
        for provider in PROVIDERS:
            for value in LEGACY_UNUSED:
                with self.subTest(provider=provider, metadataType=type(value).__name__):
                    payload = {'targetLang': 'th', 'operationId': 'old-owned-operation',
                        'provider': {'id': provider, 'apiKey': 'synthetic-owner', 'model': 'fixture'},
                        'batchId': value, 'userRunId': value}
                    actual = build_config(payload)
                    self.assertEqual(actual.paid_user_run_id, '')
                    self.assertEqual((actual.provider, actual.model, actual.paid_operation_id),
                        (provider, 'fixture', 'old-owned-operation'))
                    if self.baseline:
                        self.assertEqual(asdict(actual), asdict(self.baseline['extension'].build_config(payload)))

    def test_job_nonpaid_accepts_unused39_metadata(self):
        for provider in PROVIDERS:
            for value in LEGACY_UNUSED:
                with self.subTest(provider=provider, metadataType=type(value).__name__):
                    payload = {'idempotency_key': 'old-owned-job',
                        'ai': {'provider': provider, 'api_key': 'synthetic-owner', 'model': 'fixture'},
                        'metadata': {'batch_id': value, 'image_id': 'original-image'},
                        'context': {'page_url': 'https://fixture.invalid/', 'tp_tab_session': 'original-owner'}}
                    actual = build_ai_config(payload, 'lens_text', 'ai')
                    self.assertEqual(actual.paid_user_run_id, '')
                    self.assertEqual((actual.provider, actual.model, actual.paid_operation_id),
                        (provider, 'fixture', 'old-owned-job'))
                    if self.baseline:
                        self.assertEqual(asdict(actual), asdict(self.baseline['job'].build_ai_config(payload, 'lens_text', 'ai')))

    def test_paid_exact_owner_and_legacy_fallback_are_retained(self):
        provider = {'id': 'paid', 'apiKey': 'synthetic-owner'}
        actual = build_config({'provider': provider, 'userRunId': 'owned-click',
            'batchId': 'different-legacy-click', 'operationId': 'owned-provider-operation'})
        self.assertEqual((actual.paid_user_run_id, actual.paid_operation_id),
            ('owned-click', 'owned-provider-operation'))
        for absent in (None, ''):
            self.assertEqual(build_config({'provider': provider, 'userRunId': absent,
                'batchId': 'legacy-owned-click'}).paid_user_run_id, 'legacy-owned-click')
        actual = build_ai_config({'ai': {'provider': 'paid', 'api_key': 'synthetic-owner'},
            'idempotency_key': 'owned-provider-operation', 'metadata': {'batch_id': 'owned-click'}}, 'lens_text', 'ai')
        self.assertEqual((actual.paid_user_run_id, actual.paid_operation_id),
            ('owned-click', 'owned-provider-operation'))

    def test_paid_invalid_explicit_owner_cannot_fall_back_or_normalize(self):
        invalid = ('not an opaque id', 'งาน-เดิม', 'x' * 121, {}, [], False, 0)
        for value in invalid:
            with self.subTest(metadataType=type(value).__name__):
                with self.assertRaises(ValueError):
                    build_config({'provider': {'id': 'paid', 'apiKey': 'synthetic-owner'},
                        'userRunId': value, 'batchId': 'valid-but-different-owner'})
                with self.assertRaises(ValueError):
                    build_ai_config({'ai': {'provider': 'paid', 'api_key': 'synthetic-owner'},
                        'metadata': {'batch_id': value}}, 'lens_text', 'ai')

    def test_optional_absent_run_remains_absent(self):
        for provider in (*PROVIDERS, 'paid'):
            self.assertEqual(build_config({'provider': {'id': provider,
                'apiKey': 'synthetic-owner'}}).paid_user_run_id, '')
            self.assertEqual(build_ai_config({'ai': {'provider': provider,
                'api_key': 'synthetic-owner'}}, 'lens_text', 'ai').paid_user_run_id, '')


if __name__ == '__main__':
    unittest.main()
