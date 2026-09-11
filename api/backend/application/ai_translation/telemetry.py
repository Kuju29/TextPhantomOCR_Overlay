"""Success telemetry for API translation."""

from collections.abc import Mapping

from backend import trace
from backend.api.errors import activity_fields
from backend.log import event

def emit_success(*, body: dict, missing: list[str], declined: list[str],
                 passthrough: list[str], route_identity: dict,
                 rate_entry: Mapping[str, object] | None,
                 trace_id: str, correlation: dict | None = None) -> None:
    meta = body["meta"]
    rate_entry_fields = rate_entry if isinstance(rate_entry, Mapping) else {}
    activity_correlation = dict(correlation or {})
    activity_correlation.setdefault("traceId", trace_id)
    activity_correlation.setdefault("operationId", str(body.get("operationId") or ""))
    event("v1.ai.translate", {
        "units": meta["units"], "translated": len(body["translations"]),
        "missing": len(missing), "missing_ids": missing,
        "omitted_ids": meta["omittedIds"], "declined_ids": declined,
        "provider": meta["provider"], "model": meta["model"], "dt_ms": meta["dt_ms"],
        "rate_wait_ms": meta["rateWaitMs"], "rpm_now": meta["rate"].get("rpm"),
        "admission_wait_ms": meta["admissionWaitMs"], "provider_ms": meta["providerMs"],
        "parse_ms": meta["parseMs"], "usage": meta["usage"],
        "finish_reason": meta["finishReason"], "timeout_policy": meta["timeoutPolicy"],
        **route_identity, "rate_mode": meta["rateMode"],
        **activity_fields(
            # Missing markers are observed at our response boundary; without a
            # wire record we cannot distinguish model omission from decoding.
            owner="unknown" if missing else "textphantom",
            outcome="partial" if missing else "succeeded",
            severity="warning" if missing else "info",
            stage="response_contract" if missing else "ai_translate",
            retryable=bool(missing),
            scope="image" if activity_correlation.get("imageId") else "request",
            correlation=activity_correlation,
            code="missing_translation_units" if missing else "",
            phase="repair" if route_identity.get("compatibilityAlias") and "/repair-runs/" in str(route_identity.get("requestedRoute") or "") else "initial",
            attempt=int(meta.get("generationAttempts") or 1), final=True,
        ),
    }, ok=not missing)
    waits = {"rate_gate": float(meta["rateWaitMs"]), "provider": float(meta["providerMs"] or 0),
             "admission": float(meta["admissionWaitMs"]), "parse": float(meta["parseMs"] or 0)}
    dominant = max(waits, key=waits.get) if max(waits.values()) > 0 else "none"
    effective_prompt_meta = {key: meta.get(key) for key in (
        "targetLang", "promptVersion", "promptSource", "userPromptPresent", "userPromptChars",
        "promptMode", "effectiveStyleChars", "effectiveStyleFingerprint",
        "effectiveSystemPromptChars", "effectiveSystemPromptFingerprint") if key in meta}
    trace.write("api", "api/routes/ai_v1.py", "ai_translate_v1", "<-", {
        "translated": len(body["translations"]), "missing": len(missing),
        "dominantWait": dominant, "rateRpmOnEntry": rate_entry_fields.get("rpm", 0),
        "rateQueueDepthOnEntry": rate_entry_fields.get("waiting", 0),
        "rateOkStreakOnEntry": rate_entry_fields.get("okStreak", 0),
        "rateOkStreakTarget": rate_entry_fields.get("okStreakTarget", 0),
        "missingIds": missing, "omittedIds": meta["omittedIds"], "declinedIds": declined,
        "passthroughIds": passthrough, "provider": meta["provider"], "model": meta["model"],
        "dt_ms": meta["dt_ms"], "rateWaitMs": meta["rateWaitMs"],
        "admissionWaitMs": meta["admissionWaitMs"], "providerMs": meta["providerMs"],
        "parseMs": meta["parseMs"], "usage": meta["usage"], "finishReason": meta["finishReason"],
        "timeoutPolicy": meta["timeoutPolicy"], **route_identity, "rateMode": meta["rateMode"],
        "rate": meta["rate"], "vision": meta["vision"], "markersFound": meta["markersFound"],
        "outputContract": meta["outputContract"], "responseShape": meta["responseShape"],
        "acceptedLosslessly": meta["acceptedLosslessly"], "contentModified": meta["contentModified"],
        "providerAttempts": meta["providerAttempts"], "generationAttempts": meta["generationAttempts"],
        "httpAttempts": meta["httpAttempts"], "automaticContentRetry": False,
        "automaticTransportRetry": False, "modelFallback": False, "schemaFallback": False,
        "aiFlow": meta["aiFlow"], "passthroughUnits": meta["passthroughUnits"],
        "memoryCharacters": len(body["memoryDelta"]["characters"]),
        "memoryGlossary": len(body["memoryDelta"]["glossary"]), **effective_prompt_meta,
    }, trace_id=trace_id)
