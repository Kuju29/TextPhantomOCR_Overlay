"""Native request window policy; /api/ps reports allocation, not architectural maximum."""
import math
from backend.ai.workload import positive

POLICY_VERSION = "ollama-request-context-v1"
AUTO_CEILING = 16384

def plan_ollama_context(limits=None, estimate=None):
    limits, estimate = limits or {}, estimate or {}
    if limits.get("scope") != "runtime" or not str(limits.get("source", "")).startswith("ollama-api"):
        return None
    model = positive(limits.get("modelContextTokens"))
    runtime = positive(limits.get("runtimeContextTokens")) or positive(limits.get("contextTokens"))
    configured = positive(limits.get("configuredContextTokens"))
    current = min(model or math.inf, runtime or configured or 4096)
    ceiling = min(model, max(current, AUTO_CEILING)) if model else current
    inp = max(0, estimate.get("estimatedInput", 0) or 0)
    output = max(0, estimate.get("predictedOutput", 0) or 0)
    reasoning = max(0, estimate.get("reasoningReserve", 0) or 0)
    raw_required = inp + output + reasoning + 128 + max(256, output * .5)
    required = math.ceil(raw_required) if math.isfinite(raw_required) else math.inf
    minimum = min(ceiling, positive(estimate.get("minimumContextTokens")) or 0)
    wanted = max(minimum, current if current >= required else
                 math.ceil(required / 4096) * 4096 if math.isfinite(required) else math.inf)
    requested = min(ceiling, wanted)
    return {"limits": {**limits, "contextTokens": requested}, "evidence": {
        "runtimeContext": runtime, "modelContext": model, "requestedContext": requested,
        "contextCeiling": ceiling, "contextRequired": required if math.isfinite(required) else None,
        "contextPolicy": POLICY_VERSION,
        "contextReason": "bounded_growth" if requested > current else
            ("bounded_limit" if model else "model_limit_unknown") if required > ceiling else "current_window",
        "contextVerified": False}}
