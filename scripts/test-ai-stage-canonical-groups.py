from __future__ import annotations

import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai.translation.contracts import AiConfig  # noqa: E402
from backend.ai import markers  # noqa: E402
from backend.jobs.stages import ai_conservation, ai_repair, ai_stage, config  # noqa: E402


def paragraph(text: str) -> dict:
    return {"text": text, "items": []}


def canonical_tree() -> dict:
    return {"schema": "tp.canonical-original-tree/1", "coverage": {"complete": True}, "paragraphs": [{
        "id": "as_test",
        "text": "右左",
        "source": {
            "contract": "tp.ai-source-members/1",
            "separator": "",
            "fullParts": ["右", "左"],
            "translationParts": ["右", "左"],
            "rawParagraphIndices": [0, 1],
            "rawParagraphIds": ["right", "left"],
            "documentParagraphIds": ["p0", "p1"],
        },
    }]}


class CanonicalAiGroupingTests(unittest.TestCase):
    def test_missing_groups_fail_before_provider_dispatch(self):
        tree = {"paragraphs": [paragraph("本文")]}
        with patch.object(ai_stage.ai_repair, "translate_with_one_repair") as dispatch:
            with self.assertRaisesRegex(
                ai_conservation.AiInputConservationError,
                "ai_source_tree_required",
            ):
                ai_stage.run_ai_layer(
                    {}, tree, tree, AiConfig(api_key=""), "th", 100, 100, "", ""
                )
        dispatch.assert_not_called()

    def test_v1_contract_fails_before_provider_dispatch(self):
        source = canonical_tree()
        source["paragraphs"][0]["source"]["contract"] = "tp.ai-source-members/0"
        tree = {"paragraphs": [paragraph("右"), paragraph("左")]}
        with patch.object(ai_stage.ai_repair, "translate_with_one_repair") as dispatch:
            with self.assertRaisesRegex(
                ai_conservation.AiInputConservationError,
                "canonical_source_contract_invalid",
            ):
                ai_stage.run_ai_layer(
                    {}, tree, tree, AiConfig(api_key=""), "th", 100, 100, "", "",
                    ai_source_tree=source,
                )
        dispatch.assert_not_called()

    def test_units_use_contract_raw_indices_not_legacy_para_indices(self):
        source = canonical_tree()
        groups, indices, texts = ai_stage._canonical_group_units(
            source, ["右", "左"]
        )
        self.assertEqual(groups[0]["para_indices"], [0, 1])
        self.assertEqual(indices, [[0, 1]])
        self.assertEqual(texts, ["右左"])

    def test_ai_stage_contains_no_lazy_regroup(self):
        source = pathlib.Path(ai_stage.__file__).read_text(encoding="utf-8")
        self.assertNotIn("group_paragraphs_into_bubbles", source)
        self.assertNotIn("per_paragraph_fallback", source)

    def test_runsapi_partial_spends_exactly_one_provider_generation(self):
        calls = []

        def provider(source_text, target_lang, ai_config, **kwargs):
            calls.append((source_text, target_lang, kwargs.get("is_retry")))
            return {
                "aiTextFull": markers.apply(["แปลแล้ว", ""]),
                "meta": {
                    "provider": "mock",
                    "model": "mock-model",
                    "generationAttempts": 1,
                    "providerAttempts": 1,
                },
            }

        result = ai_repair.translate_with_one_repair(
            markers.apply(["ต้นฉบับหนึ่ง", "ต้นฉบับสอง"]),
            "th",
            AiConfig(api_key="", repair_enabled=False),
            2,
            translate_fn=provider,
        )

        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0][2])
        self.assertEqual(result["meta"]["generation_attempts"], 1)
        self.assertEqual(result["meta"]["generationAttempts"], 1)
        self.assertFalse(result["meta"]["repair_attempted"])
        self.assertEqual(result["meta"]["missing_units"], [1])

    def test_runsapi_config_cannot_reenable_second_generation(self):
        payload = {
            "ai": {
                "provider": "ollama",
                "base_url": "http://localhost:11434",
                "model": "mock",
                "prompt_mode": "replace",
                "prompt": "style",
                "repair": {"enabled": True},
            }
        }
        ai_config = config.build_ai_config(payload, "lens_text", "ai")
        self.assertIsNotNone(ai_config)
        self.assertFalse(ai_config.repair_enabled)

    def test_runsapi_thinking_defaults_and_normalizes_to_off(self):
        base = {"provider": "ollama", "base_url": "http://localhost:11434",
                "model": "mock", "prompt_mode": "replace", "prompt": "style"}
        for value in (None, "", "auto", "garbage", False, 7):
            ai = dict(base)
            if value is not None:
                ai["thinking"] = value
            self.assertEqual(config.build_ai_config({"ai": ai}, "lens_text", "ai").thinking, "off")
        for value in ("off", "OFF"):
            self.assertEqual(config.build_ai_config({"ai": {**base, "thinking": value}},
                                                    "lens_text", "ai").thinking, "off")
        self.assertEqual(config.build_ai_config({"ai": {**base, "thinking": "on"}},
                                                "lens_text", "ai").thinking, "on")


if __name__ == "__main__":
    unittest.main()
