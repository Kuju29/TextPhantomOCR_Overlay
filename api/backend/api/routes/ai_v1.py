"""HTTP routes for extension-owned text translation."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Request

from backend.application.ai_translation.orchestration import ai_schema, execute
from backend.application.ai_translation.streaming import phases_requested, respond, until_disconnect

router = APIRouter()

@router.get("/v1/ai/schema")
async def get_ai_schema() -> dict:
    return await ai_schema()
@router.post("/v1/ai/translate")
@router.post("/v2/engine/runsextension/ai/translate")
@router.post("/v2/engine/runsextension/login/translate")
async def ai_translate_v1(
    request: Request,
    payload: dict[str, Any],
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    if "/login/" in request.url.path and payload.get("provider", {}).get("id") != "login":
        from fastapi import HTTPException
        raise HTTPException(400, detail={"code": "login_provider_required"})
    if payload.get("translationMode") == "conversation" and "application/x-ndjson" in request.headers.get("accept", ""):
        return await respond(request, lambda **kwargs: execute(request, payload, idempotency_key, **kwargs),
                             phases=phases_requested(request))
    return await until_disconnect(request, lambda **kwargs: execute(request, payload, idempotency_key, **kwargs))
