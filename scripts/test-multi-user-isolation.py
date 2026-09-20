"""Offline ownership matrix for the server paths shared by many extension users."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend import cancellation
from backend.ai.provider_resolution import _capability_scope
from backend.ai.translation_paths.mode import scope_material
from backend.api.routes.repair_runs import caller_scope
from backend.jobs.admission import identity_of
from backend.jobs.cache import build_cache_key


class Request:
    def __init__(self, session: str, host: str = "203.0.113.9", origin: str = "chrome-extension://same"):
        self.headers = {"x-tp-tab-session": session, "origin": origin}
        self.client = SimpleNamespace(host=host)


def ai(*, owner: str, key: str, document: str = "doc"):
    return SimpleNamespace(
        conversation={"owner": owner, "documentId": document, "reset": "automatic"},
        provider="openrouter", model="fixture/model", base_url="https://openrouter.ai/api/v1",
        api_key=key, source_lang="ja", prompt_editable="STYLE", prompt_mode="replace",
        memory_mode="off", thinking="off", send_image=False, image_b64="", output_contract="markers",
        style_examples=False, series_state="", speakers={}, prev_context=[], page_context=[],
        source_context=[], glossary=[], characters=[], char_memory=False,
    )


def main():
    # Admission: same provider/key still gets separate fairness lanes by tab session.
    a_payload = {"context": {"tp_tab_session": "tab-a"}, "ai": {"api_key": "shared-key"}}
    b_payload = {"context": {"tp_tab_session": "tab-b"}, "ai": {"api_key": "shared-key"}}
    assert identity_of(a_payload) != identity_of(b_payload)

    # Cancellation: an identical batch ID in another tab session is not cancelled.
    cancellation._batches.clear()
    cancellation.mark_batch("batch-same", "tab-a")
    assert cancellation.is_cancelled({"batch_id": "batch-same", "context": {"tp_tab_session": "tab-a"}})
    assert not cancellation.is_cancelled({"batch_id": "batch-same", "context": {"tp_tab_session": "tab-b"}})

    # Conversation: owner and credential are both part of the private scope.
    a = ai(owner="owner-a", key="key-a")
    b_owner = ai(owner="owner-b", key="key-a")
    b_key = ai(owner="owner-a", key="key-b")
    assert scope_material(a, "th") != scope_material(b_owner, "th")
    assert scope_material(a, "th") != scope_material(b_key, "th")

    # AI result cache: private owner/key scope prevents cross-user replay.
    key_a = build_cache_key("image", "th", "text", "ai", a, owner_scope="tab-a")
    key_b = build_cache_key("image", "th", "text", "ai", b_owner, owner_scope="tab-b")
    assert key_a != key_b

    # Provider capability/probe memory is account scoped even for same model/endpoint.
    assert _capability_scope("openrouter", "https://openrouter.ai/api/v1", "key-a") != \
           _capability_scope("openrouter", "https://openrouter.ai/api/v1", "key-b")

    # Repair quota fairness follows the random tab session, not shared NAT/origin.
    assert caller_scope(Request("tab-a")) != caller_scope(Request("tab-b"))
    assert caller_scope(Request("tab-a")) == caller_scope(Request("tab-a"))

    print("PASS multi-user isolation: admission, cancellation, Conversation, result cache, capability cache and repair quota")


if __name__ == "__main__":
    main()
