"""Success telemetry for API translation."""

from backend import trace
from backend.log import event

def emit_success(*, body: dict, missing: list[str], declined: list[str],
                 passthrough: list[str], route_identity: dict, rate_entry: dict,
                 trace_id: str) -> None:
    meta = body["meta"]
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
        "dominantWait": dominant, "rateRpmOnEntry": rate_entry.get("rpm", 0),
        "rateQueueDepthOnEntry": rate_entry.get("waiting", 0),
        "rateOkStreakOnEntry": rate_entry.get("okStreak", 0),
        "rateOkStreakTarget": rate_entry.get("okStreakTarget", 0),
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
