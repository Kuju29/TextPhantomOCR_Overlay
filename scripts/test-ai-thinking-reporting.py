"""No-network regressions for completion and truthful thinking metadata."""
import unittest
from unittest.mock import patch

from backend.ai import markers
from backend.ai.clients.base import ChatResult, LineCompletionDetector
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import local_ollama
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig


class ThinkingAndCompletionTests(unittest.TestCase):
    def test_exact_terminal_newline(self):
        for ending in ("", "\n", "\r\n"):
            with self.subTest(ending=repr(ending)):
                self.assertEqual(LineCompletionDetector(["P0"]).inspect(
                    "<<TP_P0:translated>>" + ending, 1), "all_id_records_closed")
        for ending in ("\n\n", "\r\n\r\n", "\r", "\nprose"):
            self.assertIsNone(LineCompletionDetector(["P0"]).inspect(
                "<<TP_P0:translated>>" + ending, 1))
        for legacy in ("<<TP_P0>> translated\n", "<<TP_P0>>\ntranslated\n<<TP_END>>",
                       "<<TP_P0>>\ntranslated\n<<TP_DONE>>"):
            self.assertIsNone(LineCompletionDetector(["P0"]).inspect(legacy, 1))

    def test_missing_adapter_acknowledgement_is_unverified(self):
        adapter = invocation.provider_registry.require("lmstudio").adapter
        for selected in ("off", "on"):
            with self.subTest(selected=selected), patch.object(type(adapter), "generate",
                    return_value=ChatResult("<<TP_P0:translated>>", "test-model")), \
                    patch.object(invocation, "decode_result", side_effect=lambda **values: {**values, "meta": {}}), \
                    patch.object(invocation, "assert_ai_base_url_allowed"):
                result = invocation._translate_once(markers.apply(["source"]), "en", AiConfig(
                    api_key="", provider="lmstudio", model="test-model",
                    base_url="http://localhost:1234/v1", thinking=selected,
                    prompt_mode="replace", prompt_editable="Translate accurately."))
                self.assertEqual(result["thinking_selected"], selected)
                self.assertEqual(result["thinking_applied"], "unverified")

    def test_ollama_reports_request_without_claiming_application(self):
        for selected in ("off", "on", "default"):
            with patch.object(local_ollama, "generate", return_value=ChatResult("text", "model")) as generate:
                result = local_ollama.ADAPTER.generate(GenerationRequest(
                    provider="ollama", model="renamed-model", system_text="style",
                    user_parts=("source",), thinking=selected))
                mode = "off" if selected == "default" else selected
                self.assertEqual(generate.call_args.kwargs["thinking"], mode)
                self.assertEqual(result.thinking_applied, f"requested_{mode}_unverified")


if __name__ == "__main__":
    unittest.main()
