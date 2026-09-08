"""HTTP routes for extension-owned text translation."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Request

from backend.application.ai_translation.orchestration import ai_schema, execute

router = APIRouter()

@router.get("/v1/ai/schema")
async def get_ai_schema() -> dict:
    return await ai_schema()
@router.post("/v1/ai/translate")
@router.post("/v2/engine/runsextension/ai/translate")
async def ai_translate_v1(
    request: Request,
    payload: dict[str, Any],
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    return await execute(request, payload, idempotency_key)
