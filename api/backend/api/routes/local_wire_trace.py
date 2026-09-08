"""Authenticated internal relay for extension-owned Direct Local AI traces."""

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException, Request

from backend.ai import local_wire_relay

router = APIRouter()

@router.post("/v2/engine/runsextension/ai/local-wire-trace", status_code=202)
async def local_wire_trace(
    request: Request,
    capability: str = Header(default="", alias="X-TP-AI-Wire-Capability"),
    trace_id: str = Header(default="", alias="X-TP-Trace-Id"),
    request_id: str = Header(default="", alias="X-TP-Request-Id"),
    job_id: str = Header(default="", alias="X-TP-Job-Id"),
    batch_id: str = Header(default="", alias="X-TP-Batch-Id"),
    image_id: str = Header(default="", alias="X-TP-Image-Id"),
) -> dict[str, object]:
    if not local_wire_relay.authorized(capability):
        raise HTTPException(status_code=404, detail="not found")
    try:
        content_length = int(request.headers.get("content-length") or 0)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid content length") from None
    if content_length > local_wire_relay.MAX_EVENT_BYTES:
        raise HTTPException(status_code=413, detail="trace event too large")
    try:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > local_wire_relay.MAX_EVENT_BYTES:
                raise OverflowError("local wire trace event exceeds size limit")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("local wire trace payload must be an object")
        identity = payload.get("identity")
        if not isinstance(identity, dict):
            raise ValueError("local wire trace identity is required")
        required_headers = ("x-tp-trace-id", "x-tp-request-id", "x-tp-job-id",
                            "x-tp-batch-id", "x-tp-image-id")
        if any(name not in request.headers for name in required_headers):
            raise ValueError("local wire trace correlation headers are required")
        correlations = (
            (trace_id, "traceId"), (request_id, "operationId"),
            (job_id, "jobId"), (batch_id, "batchId"), (image_id, "imageId"),
        )
        for header_value, identity_key in correlations:
            if header_value != str(identity.get(identity_key) or ""):
                raise ValueError(f"local wire trace {identity_key} header/body mismatch")
        # Trace persistence is synchronous filesystem work and must not block
        # unrelated API requests on the event-loop thread.
        await asyncio.to_thread(local_wire_relay.receive, payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid trace JSON") from exc
    except OverflowError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True}
