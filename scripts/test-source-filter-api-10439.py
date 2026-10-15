"""All original Unicode singletons must skip, including NFC expansions."""
from pathlib import Path
import sys
import unicodedata
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.provider_registry import provider_registry
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate


class AllSingletonSource(unittest.TestCase):
    def test_actual_nfc_expanding_singleton_never_reaches_generation(self):
        source = '\u0958'  # DEVANAGARI LETTER QA expands under NFC.
        self.assertGreater(len(unicodedata.normalize('NFC',source)),1)
        config = AiConfig(api_key='fixture-key',provider='openrouter',model='fixture-model',
            thinking='default',style_examples=False)
        with patch.object(provider_registry.require('openrouter').adapter,'generate',
                return_value=ChatResult(text='<<TP_P0:I>>',used_model='fixture-model',
                    finish_reason='stop',terminal_completed=True,terminal_evidence='provider_done')) as generate:
            result = translate(markers.apply([source]),'en',config)
            generate.assert_not_called()
        self.assertEqual(result['aiTextFull'],markers.apply([source]))
        self.assertEqual(result['meta']['generationAttempts'],0)
        self.assertEqual(result['meta']['providerAttempts'],0)

    def test_every_unicode_scalar_singleton_is_ineligible(self):
        for point in range(0x110000):
            if 0xD800 <= point <= 0xDFFF:
                continue  # Surrogates are not Unicode scalar values.
            if markers.has_translatable_text(chr(point)):
                self.fail(f'Original singleton U+{point:04X} reached source eligibility')

    def test_ignored_points_do_not_make_original_singleton_eligible(self):
        expansions = [chr(point) for point in range(0x110000)
            if not 0xD800 <= point <= 0xDFFF and len(unicodedata.normalize('NFC',chr(point))) > 1]
        self.assertIn('\u0958',expansions)
        for source in expansions:
            for ignored in (' ', '\u200d', '\ufe0f', '\U000e0100', '\u0000'):
                with self.subTest(point=f'U+{ord(source):04X}',ignored=repr(ignored)):
                    self.assertFalse(markers.has_translatable_text(source+ignored))
                    self.assertFalse(markers.has_translatable_text(ignored+source))

    def test_existing_nfc_and_thai_rules_remain(self):
        for source in ('ดี','มี','ที่','ฉัน','漢字','AB','A!','A😀','\u0958A'):
            with self.subTest(source=source):
                self.assertTrue(markers.has_translatable_text(source))
        for source in ('A\u0301','\u1100\u1161','12','!!','😀😀','A\u200d','漢\ufe0f'):
            with self.subTest(source=source):
                self.assertFalse(markers.has_translatable_text(source))


if __name__=='__main__':
    unittest.main(verbosity=2)
