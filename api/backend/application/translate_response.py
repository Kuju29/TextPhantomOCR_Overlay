"""Successful translation result mapping and completion telemetry."""

from __future__ import annotations

import time
from typing import Any

from backend import trace
from backend.ai.rategate import rate_gate
from backend.log import event

def finalize(result: dict[str, Any], *, prepared, api_version: str,
             rate: dict[str, Any], paced: bool, rate_wait_ms: float,
             admission_wait_ms: float, rate_provider: str,
             rate_model: str, api_key: str) -> dict[str, Any]:
    result["apiVersion"] = api_version
    perf = result.get("perf") if isinstance(result.get("perf"), dict) else {}
    ai_meta = ((result.get("Ai") or {}).get("meta") or {})
    waits = {
        "rate_gate": float(rate_wait_ms or 0.0),
        "admission": float(admission_wait_ms or 0.0),
        "provider": float(ai_meta.get("provider_ms") or perf.get("ai_ms") or 0.0),
        "parse": float(ai_meta.get("provider_parse_ms") or perf.get("ai_parse_ms") or 0.0),
    }
    dominant = max(waits, key=waits.get) if max(waits.values()) > 0 else "none"
    trace.write("api", "api/routes/translate_v1.py", "translate_sync", "<-", {
        **prepared.route_identity, "pipeline": result.get("pipelinePath"),
        "rateWaitMs": rate_wait_ms, "rateMode": rate["mode"],
        "admissionWaitMs": admission_wait_ms, "providerMs": perf.get("ai_ms", 0.0),
        "parseMs": perf.get("ai_parse_ms", 0.0), "dominantWait": dominant,
        "paced": paced,
        "rate": rate_gate.snapshot(rate_provider, rate_model, api_key) if paced else None,
        "aiMeta": {key: value for key, value in ai_meta.items() if key in (
            "units", "missing_units", "passthrough_units", "skipped_reason", "usage",
            "finish_reason", "timeout_policy", "generation_attempts")},
        "backgroundMode": result.get("backgroundMode"),
        "hasLensDocument": bool(result.get("lensDocument")),
        "docParagraphs": len((result.get("lensDocument") or {}).get("paragraphs") or []),
        "hasEraseBoxes": bool(result.get("eraseBoxes")),
        "hasImageDataUri": bool(result.get("imageDataUri")),
        "hasOriginalHtml": bool((result.get("original") or {}).get("originalhtml")),
        "hasTranslatedHtml": bool((result.get("translated") or {}).get("translatedhtml")),
        "hasAiHtml": bool((result.get("Ai") or {}).get("aihtml")), "perf": perf,
    }, trace_id=prepared.trace_id)
    trace.flush()
    event("v1.translate", {
        "mode": prepared.mode, "source": prepared.source,
        "lang": str(prepared.payload.get("lang") or ""),
        "total_ms": round((time.perf_counter() - prepared.started) * 1000, 1),
        **prepared.route_identity, "rate_mode": rate["mode"],
        "rate_wait_ms": rate_wait_ms, "admission_wait_ms": admission_wait_ms,
        "provider_ms": perf.get("ai_ms", 0.0), "parse_ms": perf.get("ai_parse_ms", 0.0),
        "cache": perf.get("cache", ""), "background": result.get("backgroundMode", ""),
    })
    return result
