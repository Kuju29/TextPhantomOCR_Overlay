#!/usr/bin/env python3
"""Focused regression checks for multi-user activity classification."""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.api import errors  # noqa: E402
from backend.api.activity_dedupe import TransitionDedupe  # noqa: E402


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


first = {
    "batchId": "batch-a", "imageId": "image-a", "requestId": "attempt-1",
}
second = {**first, "requestId": "attempt-2"}
one = errors.activity_fields(
    owner="provider", outcome="failed", severity="warning",
    stage="provider_request", retryable=False, scope="image",
    correlation=first, code="provider_http", final=False,
)
two = errors.activity_fields(
    owner="provider", outcome="failed", severity="warning",
    stage="provider_request", retryable=False, scope="image",
    correlation=second, code="provider_http", final=False,
)
check(one["incidentId"] == two["incidentId"], "retry attempts must share an incident")
check(one["requestId"] != two["requestId"], "attempt request IDs must remain distinct")
check(one["correlation"]["imageId"] == "image-a", "nested correlation envelope missing")

operation_retry_1 = errors.activity_fields(
    owner="provider", outcome="failed", severity="warning",
    stage="provider_request", retryable=True, scope="image",
    correlation={"batchId": "shared-batch", "operationId": "operation-a",
                 "imageId": "image-a", "requestId": "request-1"},
    code="provider_timeout", final=False,
)
operation_retry_2 = errors.activity_fields(
    owner="provider", outcome="failed", severity="warning",
    stage="provider_request", retryable=True, scope="image",
    correlation={"batchId": "shared-batch", "operationId": "operation-a",
                 "imageId": "image-a", "requestId": "request-2"},
    code="provider_timeout", final=False,
)
other_image = errors.activity_fields(
    owner="provider", outcome="failed", severity="warning",
    stage="provider_request", retryable=True, scope="image",
    correlation={"batchId": "shared-batch", "operationId": "operation-b",
                 "imageId": "image-b", "requestId": "request-3"},
    code="provider_timeout", final=False,
)
check(operation_retry_1["incidentId"] == operation_retry_2["incidentId"],
      "changing request IDs must not split one operation incident")
check(operation_retry_1["incidentId"] != other_image["incidentId"],
      "distinct operations/images in one batch must not be merged")

# Two users may independently mint the same local operation identifier. Their
# privacy-safe namespaces must prevent cross-user incident merging.
user_a = errors.activity_fields(
    owner="unknown", outcome="failed", severity="warning", stage="provider_request",
    retryable=True, scope="image", code="provider_timeout",
    correlation={"operationId": "same-operation", "userScopeHash": "opaque-a"}, final=False)
user_b = errors.activity_fields(
    owner="unknown", outcome="failed", severity="warning", stage="provider_request",
    retryable=True, scope="image", code="provider_timeout",
    correlation={"operationId": "same-operation", "userScopeHash": "opaque-b"}, final=False)
check(user_a["incidentId"] != user_b["incidentId"], "multi-user incidents were merged")

anonymous = errors.activity_fields(
    owner="unknown", outcome="failed", severity="warning", stage="http_response",
    retryable=False, scope="request", code="http_400", final=True,
)
check("incidentId" not in anonymous, "anonymous 400s must not be falsely merged")
check(anonymous["owner"] == "unknown", "ambiguous HTTP failures must remain unknown")

provider = errors.classify_failure({
    "code": "provider_http", "origin": "upstream_ai", "stage": "provider_request",
    "category": "upstream", "retryable": False, "upstreamStatus": 400,
    "batchId": "batch-a", "imageId": "image-a", "providerAttempts": 1,
}, route="/v2/engine/runsextension/ai/translate")
check(provider["owner"] == "provider", "upstream boundary must be identifiable")
check(provider["final"] is False, "provider error line is an attempt, not batch verdict")
check(provider["attempt"] == 1, "known provider attempt count must be exposed")

emitted: list[tuple[str, dict, bool]] = []
original_event = errors.event
errors.event = lambda tag, data, ok=True: emitted.append((tag, data, ok))
try:
    errors.failure_event("/v2/engine/runsextension/ai/translate", {
        "code": "provider_http", "origin": "upstream_ai", "stage": "provider_request",
        "category": "upstream", "httpStatus": 502, "upstreamStatus": 400,
        "retryable": False, "batchId": "batch-a", "imageId": "image-a",
        "provider": "gemini", "model": "model-a", "providerAttempts": 1,
    })
finally:
    errors.event = original_event
logged = emitted[0][1]
check(logged["owner"] == "provider" and logged["provider"] == "gemini",
      "provider boundary and identity must be readable")
check(logged["upstreamStatus"] == 400 and logged["retryable"] is False,
      "permanent provider rejection semantics changed")

configured = errors.classify_failure({
    "code": "invalid_request", "origin": "client", "stage": "configuration",
    "category": "configuration", "retryable": False, "jobId": "job-a",
})
check(configured["owner"] == "user_config", "request configuration must be distinct")


class Request:
    headers = {
        "x-tp-request-id": "request-a", "idempotency-key": "operation-a",
        "x-tp-tab-session": "raw-private-session", "x-tp-client-version": "2026.9.9.2",
        "x-tp-client-instance-hash": "opaque-client", "x-tp-user-scope-hash": "opaque-user",
        "x-tp-run-id": "run-a", "x-tp-task-id": "task-a",
    }
    query_params = {}


correlation = errors.request_correlation(Request())
check(correlation["operationId"] == "operation-a", "operation correlation missing")
check(correlation["tabSession"].startswith("tab:"), "tab session must be opaque")
check("raw-private-session" not in correlation["tabSession"], "raw tab session leaked")
check(correlation["clientInstanceHash"].startswith("client:") and correlation["userScopeHash"].startswith("user:"),
      "privacy-safe owner scopes missing")
check("opaque-client" not in correlation["clientInstanceHash"] and "opaque-user" not in correlation["userScopeHash"],
      "client supplied identity leaked")
check(correlation["runId"] == "run-a" and correlation["taskId"] == "task-a",
      "repair correlation missing")

queued = errors.payload_correlation({
    "metadata": {"batch_id": "batch-q", "image_id": "image-q"},
    "context": {"tp_trace": "trace-q", "tp_tab_session": "private-q",
                "client_instance_hash": "raw-client-q", "user_scope_hash": "raw-user-q"},
    "idempotency_key": "operation-q",
}, job_id="job-q")
check(queued["batchId"] == "batch-q" and queued["imageId"] == "image-q",
      "queue batch/image correlation missing")
check(queued["jobId"] == "job-q" and queued["operationId"] == "operation-q",
      "queue job/operation correlation missing")
check(queued["clientInstanceHash"].startswith("client:") and "raw-client-q" not in queued["clientInstanceHash"],
      "queued client identity was not canonicalised")
check(queued["userScopeHash"].startswith("user:") and "raw-user-q" not in queued["userScopeHash"],
      "queued user identity was not canonicalised")

# Source-level guards keep neutral events from silently reverting to red errors.
middleware_source = (ROOT / "api/backend/api/middleware.py").read_text(encoding="utf-8")
lens_source = (ROOT / "api/backend/application/lens_service.py").read_text(encoding="utf-8")
queue_source = (ROOT / "api/backend/jobs/queue.py").read_text(encoding="utf-8")
check('outcome="neutral"' in middleware_source and 'stage="internet_scanner"' in middleware_source,
      "scanner summary must remain neutral")
check('outcome="neutral" if paragraphs == 0' in lens_source,
      "zero-paragraph OCR must remain neutral")
check('owner="cancelled" if cancelled else "user_config" if prompt_contract else "unknown"' in queue_source,
      "prompt-mode request contract must remain distinguishable")
trace_source = (ROOT / "api/backend/trace.py").read_text(encoding="utf-8")
check('line["occurredAt"] = event_at' in trace_source and 'line.setdefault("occurredAt", ingested_at)' in trace_source,
      "canonical occurrence/ingestion timeline fields missing")
check('line["occurredAt"] = occurred_at' in trace_source and 'line["ingestedAt"] = occurred_at' in trace_source,
      "API-native timeline fields missing")
safe_cache = errors  # keep import visible while exercising trace's private bounded formatter
from backend import trace as trace_module  # noqa: E402
cache_meta = trace_module._short({"cachedInputTokens": 768, "cacheWriteInputTokens": 32,
                                  "inputTokens": "raw-not-number", "apiKey": 12345})
check(cache_meta["cachedInputTokens"] == 768 and cache_meta["cacheWriteInputTokens"] == 32,
      "numeric cache evidence was redacted")
check(cache_meta["inputTokens"] == "<redacted>" and cache_meta["apiKey"] == "<redacted>",
      "non-numeric token/credential data leaked")
repair_source = (ROOT / "api/backend/api/routes/repair_runs.py").read_text(encoding="utf-8")
check("_activity_transitions.changed(run_id, signature, terminal=terminal)" in repair_source and
      "trace.full_enabled() or (changed and" in repair_source,
      "unchanged repair-pool activity snapshots are not suppressed")

# Bounded/terminal/TTL behavior and lock safety under concurrent run updates.
clock = [0.0]
dedupe = TransitionDedupe(max_entries=32, ttl_sec=10, clock=lambda: clock[0])
for index in range(2000):
    check(dedupe.changed(f"run-{index}", ("repairing", index, 0, 0)), "new run hidden")
check(dedupe.size() == 32, "many abandoned runs exceeded the LRU bound")
check(dedupe.changed("terminal-run", ("done", 0, 1, 0), terminal=True), "terminal hidden")
check(dedupe.size() == 32, "terminal run was retained")
clock[0] = 20.0
dedupe.changed("fresh", ("repairing", 1, 0, 0))
check(dedupe.size() == 1, "expired abandoned runs were retained")

from concurrent.futures import ThreadPoolExecutor  # noqa: E402
concurrent = TransitionDedupe(max_entries=64, ttl_sec=60)
def update(index: int) -> None:
    concurrent.changed(f"shared-{index % 17}", ("repairing", index % 5, 0, 0),
                       terminal=index % 19 == 0)
with ThreadPoolExecutor(max_workers=12) as pool:
    list(pool.map(update, range(5000)))
check(concurrent.size() <= 64, "concurrent transition updates exceeded the bound")

print("activity observability contract: OK")
