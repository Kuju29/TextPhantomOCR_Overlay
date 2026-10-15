"""Synthetic invocation → actual native HTTP payloads; no live provider calls.

Run: python scripts/test-context-cache-matrix-10416.py

Captures the real provider leaves after build_ai_config and Conversation prep.
The synthetic image checks native image-part presence, not image decoding.
Account metadata deliberately proves a non-reasoning fixture model; Lowest
intent stays minimum, while its concrete no-control selection is default.
"""

import json
import os
import runpy
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
assert (ROOT / "api/backend/ai/translation/invocation.py").is_file(), (
    "Run this QA fixture from the TextPhantom source directory"
)
sys.path.insert(0, str(ROOT / "api"))
h = runpy.run_path(
    str(ROOT / "scripts/test-api-provider-boundary-matrix.py"), run_name="helpers"
)

from backend.ai import markers
from backend.ai.provider_registry import provider_registry
from backend.ai.translation.invocation import translate
from backend.jobs.stages.config import build_ai_config


def main():
    cloud = [spec for spec in provider_registry if not spec.local]
    assert len(cloud) == 9
    client = h["BoundaryClient"]
    response = h["Response"]
    caps = {
        "reasoning": {"supported": False, "source": "fixture"},
        "vision": {"supported": True, "source": "fixture"},
        "structured_output": {"supported": False},
        "limits": {"contextTokens": 65536},
    }
    checks = 0
    # This is the legacy queued/full-server configuration boundary. It must
    # retain caller source context and reject malformed source-context types.
    source_context = [{
        "targetIds": ["I1_P0"],
        "units": [{"id": "context", "text": "SOURCE_CONTEXT_SENTINEL"}],
    }]
    base_payload = {"ai": {
        "provider": "huggingface", "model": "fixture-model",
        "api_key": "fixture", "source_context": source_context,
    }}
    assert build_ai_config(base_payload, "lens_text", "ai").source_context == source_context
    for malformed in (None, "wrong-type", {"units": []}):
        bad = {"ai": {**base_payload["ai"], "source_context": malformed}}
        assert build_ai_config(bad, "lens_text", "ai").source_context == []
    print("PASS build_ai_config preserves source_context; 3 malformed types stay empty")

    with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {
        "TP_CONVERSATION_STATE_FILE": td + "/history.sqlite",
        "TP_AI_WIRE_TRACE": "0", "TP_USAGE_RECEIPTS": "off",
    }):
        for spec in cloud:
            for memory in ("off", "terms", "full"):
                for examples in (False, True):
                    for image in (False, True):
                        bodies, requests = [], []
                        client.calls = []
                        answer = "<<I1_P0:คำแปล>>"
                        # BoundaryClient's response uses the helper module's
                        # ANSWER global. Bind it to this fixture's real wire ID.
                        client.post.__globals__["ANSWER"] = answer

                        def gemini_post(_key, _model, body, _cancel=None):
                            bodies.append(body)
                            return response({
                                "candidates": [{"finishReason": "STOP", "content": {
                                    "parts": [{"text": answer}],
                                }}],
                                "usageMetadata": {"promptTokenCount": 100,
                                    "candidatesTokenCount": 10, "totalTokenCount": 110},
                            })

                        def anthropic_post(_url, **kw):
                            bodies.append(kw["json"])
                            return response({
                                "content": [{"type": "text", "text": answer}],
                                "stop_reason": "end_turn",
                                "usage": {"input_tokens": 100, "output_tokens": 10},
                            })

                        original_generate = spec.adapter.generate

                        def generate(request):
                            requests.append(request)
                            return original_generate(request)

                        document = f"{spec.provider_id}-{memory}-{examples}-{image}"
                        cfg = build_ai_config({
                            "context": {"tp_tab_session": "fixture-owner"},
                            "ai": {
                                "api_key": "fixture", "provider": spec.provider_id,
                                "model": "fixture-model", "base_url": spec.default_base_url,
                                "prompt": "STYLE_SENTINEL", "source_lang": "en",
                                "memory_mode": memory, "style_examples": examples,
                                "char_memory": memory == "full", "thinking": "minimum",
                                "model_capabilities": caps, "send_image": image,
                                "translation_mode": "conversation",
                                "conversation": {
                                    "documentId": document,
                                    "origins": [{"pageId": "page-1", "pageIndex": 0,
                                        "pageOrder": 1, "unitIds": ["I1_P0"],
                                        "originalIds": ["g0"]}],
                                },
                                "glossary": [{"src": "MemoryTerm", "tgt": "GLOSSARY_SENTINEL"}],
                                "characters": [{"name": "CHARACTER_SENTINEL",
                                    "gender": "female", "speech": "reserved"}],
                                "series_state": "SERIES_SENTINEL",
                                "prev_context": [{"src": "PREV_SENTINEL"}],
                                "page_context": [{"id": "neighbor", "text": "PAGE_SENTINEL"}],
                                "source_context": source_context,
                            },
                        }, "lens_text", "ai")
                        assert cfg.source_context == source_context, document
                        # Image acquisition/normalization is owned before this
                        # legacy invocation seam, so insert synthetic bytes here.
                        cfg.image_b64 = "ZmFrZQ==" if image else ""
                        with ExitStack() as stack:
                            stack.enter_context(patch(
                                "backend.ai.provider_resolution.discovered_model_capabilities",
                                return_value=(True, caps)))
                            stack.enter_context(patch(
                                "backend.ai.provider_resolution.refresh_hf_selected_metadata",
                                return_value=(True, caps)))
                            stack.enter_context(patch.object(h["openai_chat"].httpx, "Client", client))
                            stack.enter_context(patch.object(h["cloud_gemini"], "_post_once",
                                side_effect=gemini_post))
                            stack.enter_context(patch.object(h["cloud_anthropic"], "post_json",
                                side_effect=anthropic_post))
                            stack.enter_context(patch.object(spec.adapter, "generate",
                                side_effect=generate))
                            result = translate(markers.apply(["CURRENT_SOURCE"]), "th", cfg)

                        bodies += [call["json"] for call in client.calls if call["method"] == "POST"]
                        assert len(bodies) == len(requests) == 1, (document, len(bodies))
                        request = requests[0]
                        user = "\n\n".join(request.user_parts)
                        wire = json.dumps(bodies[0], ensure_ascii=False)
                        assert "STYLE_SENTINEL" in request.system_text and "STYLE_SENTINEL" in wire, document
                        assert ("GLOSSARY_SENTINEL" in user) == (memory != "off"), document
                        for token in ("CHARACTER_SENTINEL", "SERIES_SENTINEL", "PREV_SENTINEL"):
                            assert (token in user) == (memory == "full"), (document, token)
                        for token in ("PAGE_SENTINEL", "SOURCE_CONTEXT_SENTINEL", "CURRENT_SOURCE"):
                            assert token in user and token in wire, (document, token)
                        assert ("H01\nEN:" in user) == examples, document
                        assert request.cache_context["thinkingRequested"] == "minimum", document
                        assert bool(request.image_b64) == image, document
                        image_wire = any(token in wire for token in (
                            "image_url", "inline_data", "inlineData", '"type": "image"'))
                        assert image_wire == image, (document, image_wire)
                        assert cfg.memory_mode == memory and cfg.style_examples == examples, document
                        assert cfg.send_image == image and cfg.thinking == "minimum", document
                        assert result["meta"]["conversation"]["recordProtocol"] == "tp.translation.image-records/1", document
                        checks += 1
            print("PASS", spec.provider_id, "12 native HTTP cases: memory × examples × image")
    assert checks == 108
    print("PASS", checks, "build_ai_config → invocation → native leaf HTTP cases; synthetic providers only")


if __name__ == "__main__":
    main()
