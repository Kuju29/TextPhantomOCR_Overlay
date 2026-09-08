"""HTTP routes for synchronous API-server translation."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from backend.application.translate_service import capability_snapshot, execute

router = APIRouter()

@router.get("/v1/capabilities")
async def capabilities(request: Request) -> dict:
    return await capability_snapshot(request)
@router.post("/v1/translate")
@router.post("/v2/engine/runsapi/translate")
async def translate_sync(payload: dict[str, Any], request: Request) -> dict:
    return await execute(payload, request)
