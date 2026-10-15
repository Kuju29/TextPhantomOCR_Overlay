"""10493: the API AI result cache key follows every generation setting.

Uses the real ingress config builder (``build_ai_config``) and ``build_cache_key``:
a changed prompt / provider / model / base URL / target language / Series memory
(mode and content) / human examples / Send page image / AI think / translation
path / prompt mode is a different entry; the same settings are the same entry;
no raw prompt text is in the key.
"""
from __future__ import annotations

import copy
import json

from backend.jobs import cache as cache_mod
from backend.jobs.stages.config import build_ai_config

checks: list[str] = []
BASE = {
    "mode": "lens_text", "source": "ai", "lang": "th",
    "context": {"page_url": "https://site.test/ch1", "tp_tab_session": "s1"},
    "metadata": {"image_id": "img-1", "batch_id": "b1"},
    "ai": {"provider": "ollama", "base_url": "http://127.0.0.1:11434", "model": "qwen3:8b", "api_key": "",
           "prompt": "Translate naturally. SECRET-PROMPT-TEXT", "memory_mode": "off", "style_examples": False,
           "send_image": False, "thinking": "off", "translation_mode": "independent",
           "glossary": [], "characters": [], "series_state": "", "prev_context": []},
}


def key(payload: dict, lang: str | None = None) -> str:
    cfg = build_ai_config(payload, "lens_text", "ai")
    return cache_mod.build_cache_key("imghash", lang or payload["lang"], "lens_text", "ai", cfg,
                                     layout={"relayout_translated": True}, owner_scope="owner",
                                     independent_examples_signature="")


def variant(**ai) -> dict:
    out = copy.deepcopy(BASE)
    out["ai"].update(ai)
    return out


k0 = key(BASE)
assert key(copy.deepcopy(BASE)) == k0, "same settings must reuse the entry"
changes = {
    "prompt": {"prompt": "Translate naturally. SECRET-PROMPT-TEXT!"},
    "provider": {"provider": "lmstudio"},
    "model": {"model": "qwen3:14b"},
    "base URL": {"base_url": "http://127.0.0.1:11435"},
    "Series memory mode": {"memory_mode": "terms"},
    "Series memory glossary": {"memory_mode": "terms", "glossary": [{"src": "Hero", "tgt": "ฮีโร่"}]},
    "Series memory characters": {"memory_mode": "full", "characters": [{"name": "Aki", "gender": "female"}]},
    "Series memory state": {"memory_mode": "full", "series_state": "Chapter 1 summary"},
    "previous page context": {"memory_mode": "full", "prev_context": [{"src": "a", "tgt": "ก"}]},
    "human examples": {"style_examples": True},
    "Send page image": {"send_image": "always"},
    "AI think": {"thinking": "high"},
    "translation path": {"translation_mode": "conversation"},
}
for label, change in changes.items():
    assert key(variant(**change)) != k0, f"{label} change must miss"
assert key(BASE, lang="en") != k0, "target language change must miss"
checks.append(f"{len(changes) + 1} generation settings each change the API cache key")

# Memory content: same content -> same key; different content -> different key.
g1 = variant(memory_mode="terms", glossary=[{"src": "Hero", "tgt": "ฮีโร่"}])
assert key(g1) == key(copy.deepcopy(g1))
assert key(g1) != key(variant(memory_mode="terms", glossary=[{"src": "Hero", "tgt": "พระเอก"}]))
checks.append("Series memory content (not only on/off) is part of the key")

# Prompt mode is part of the key (build_ai_config always resolves 'replace').
cfg = build_ai_config(BASE, "lens_text", "ai")
cfg2 = copy.deepcopy(cfg)
cfg2.prompt_mode = "append"
assert (cache_mod.build_cache_key("imghash", "th", "lens_text", "ai", cfg, owner_scope="o", independent_examples_signature="")
        != cache_mod.build_cache_key("imghash", "th", "lens_text", "ai", cfg2, owner_scope="o", independent_examples_signature=""))
checks.append("prompt mode is part of the key")

# Per-run ids do not split the key; the raw prompt is never in it.
other_run = copy.deepcopy(BASE)
other_run["metadata"] = {"image_id": "img-2", "batch_id": "b2"}
assert key(other_run) == k0, "image/batch ids do not split the key"
assert "SECRET-PROMPT-TEXT" not in k0 and "Translate naturally" not in k0, "no raw prompt text in the key"
checks.append("per-run ids do not split the key; prompt text is hashed")

print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
