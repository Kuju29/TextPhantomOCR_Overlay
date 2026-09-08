"""Canonical detector-free Lens paragraph-grouping route."""

from typing import Any

from fastapi import APIRouter, Request

from backend.application.lens_grouping import group_paragraphs

router = APIRouter()


@router.post("/v2/engine/runsextension/groups")
async def groups(payload: dict[str, Any], request: Request) -> dict:
    return await group_paragraphs(payload, request)
