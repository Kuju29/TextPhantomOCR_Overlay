"""Liveness and non-invasive readiness/diagnostic endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend.ai.rategate import rate_gate
from backend.config import settings


router = APIRouter()


@router.get("/health")
async def health(request: Request, detail: bool = False) -> dict:
    """Keep the historical liveness body; opt in to safe readiness detail."""
    if not detail:
        return {"ok": True}
    return _readiness(request)


def _readiness(request: Request) -> dict:
    state = request.app.state

    def lane(gate_name: str, workers_name: str) -> dict:
        gate = getattr(state, gate_name, None)
        workers = int(getattr(state, workers_name, 0) or 0)
        stats = gate.stats().as_dict() if gate is not None else {}
        return {
            "ready": gate is not None and workers > 0,
            "state": "busy" if int(stats.get("free", 0)) == 0 else "available",
        }

    queue = getattr(state, "job_queue", None)
    rate_stats = rate_gate.stats()
    components = {
        "queue": {"ready": queue is not None},
        "lens": {
            **lane("admission_gate", "lens_executor_workers"),
            "configured": bool(settings.firebase_url),
        },
        "ai": {
            **lane("ai_admission_gate", "ai_executor_workers"),
            # Credentials are per request; absence of a server key is valid.
            "acceptsUserCredential": True,
            "rateGate": "busy" if int(rate_stats.get("waiting", 0)) else "available",
        },
        "detector": lane("cpu_admission_gate", "cpu_executor_workers"),
    }
    return {
        "ok": True,  # liveness remains backward-compatible
        "ready": all(item.get("ready", False) for item in components.values()),
        "components": components,
    }


@router.get("/ready")
async def ready(request: Request):
    """Operational detail only; performs no paid/network provider probes."""
    result = _readiness(request)
    return JSONResponse(status_code=200 if result["ready"] else 503, content=result)


@router.get("/version")
async def version() -> dict:
    """Compatibility marker retained for launchers; no release number is tracked."""
    return {"ok": True, "core": "backend.rewrite"}
