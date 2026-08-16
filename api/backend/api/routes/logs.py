"""Diagnostic log ingest.


The extension cannot write files. Its console is the only record of what it
decided, and that console is not being watched at the moment a problem
happens — which is how three regressions in a row ended up being diagnosed by
guesswork.

So it ships its log lines here and they land in `api/logs/extension-*.log`,
next to `api/logs/api-*.log`. Two files, one folder, one timeline covering both
sides of the request. That is the whole feature.

Deliberately permissive about content: this is a debugging aid for a local
server, and a schema that rejects an unexpected field would drop exactly the
line that explains the surprise. It is NOT permissive about size — a log
endpoint that can be filled by a loop is a disk-space bug.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from backend import logfile, trace
from backend.config import settings
from backend.trace_dedupe import TraceIngestDedupe, legacy_shipment_id

router = APIRouter()

MAX_RECORDS_PER_BATCH = 500
# Trace lines are one per function call, so a batch is far bigger than a log
# batch. Still bounded: an endpoint that can be filled by a loop is a disk bug.
MAX_TRACE_PER_BATCH = 4000
TRACE_DEDUPE_TTL_SEC = 10 * 60
TRACE_DEDUPE_MAX = 100_000


_trace_dedupe = TraceIngestDedupe(TRACE_DEDUPE_TTL_SEC, TRACE_DEDUPE_MAX)


@router.post("/v1/logs")
async def ingest(payload: dict[str, Any]) -> dict:
    """Append a batch of client log records."""
    if not logfile.is_enabled():
        # Says so rather than pretending to accept them: a client that believes
        # its logs are being kept, and is wrong, is worse off than one that knows.
        raise HTTPException(status_code=503, detail="file logging is disabled (TP_LOG_FILE=0)")

    records = payload.get("records")
    if not isinstance(records, list):
        raise HTTPException(status_code=400, detail="`records` must be a list")
    if len(records) > MAX_RECORDS_PER_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"{len(records)} records in one batch (max {MAX_RECORDS_PER_BATCH})",
        )

    written = logfile.client(records)
    return {"ok": True, "written": written, "dir": str(logfile.log_dir())}


@router.post("/v1/trace")
async def ingest_trace(payload: dict[str, Any]) -> dict:
    """Append a batch of browser-side TRACE lines to the shared trace file.

    Separate from ``/v1/logs`` because the two are different things with
    different switches: a user may want the decision log without a
    function-by-function trace, and almost always does.
    """
    if not trace.enabled():
        # Told, not silently dropped — the extension stops shipping on this
        # answer instead of retrying a doomed request on every batch.
        raise HTTPException(status_code=503, detail="tracing is disabled (TP_TRACE=0)")

    current_session = trace.session_id()
    expected_session = str(payload.get("traceSession") or "").strip()
    if expected_session and expected_session != current_session:
        # Reject BEFORE inspecting or writing records. The browser buffered
        # these against an API process that has ended; accepting them would
        # contaminate the new run and make its first events predate its header.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "trace_session_mismatch",
                "expectedSession": expected_session,
                "currentSession": current_session,
                "traceFile": trace.file_name(),
            },
            headers={"X-TP-Trace-Session": current_session},
        )

    records = payload.get("records")
    if not isinstance(records, list):
        raise HTTPException(status_code=400, detail="`records` must be a list")
    if len(records) > MAX_TRACE_PER_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"{len(records)} trace records in one batch (max {MAX_TRACE_PER_BATCH})",
        )

    original_records = records
    payload_producer = str(payload.get("producerId") or "").strip()
    if payload_producer:
        records = [
            ({**record, "producerId": payload_producer}
             if isinstance(record, dict) and not record.get("producerId") else record)
            for record in records
        ]
    records, duplicates = _trace_dedupe.filter_new(current_session, records)
    dropped_raw = payload.get("droppedSinceLastBatch", 0)
    try:
        dropped = max(0, min(int(dropped_raw), 1_000_000_000))
    except (TypeError, ValueError):
        dropped = 0
    shipment_id = (str(payload.get("shipmentId") or "").strip()
                   or legacy_shipment_id(dropped, original_records))
    gap_records, gap_duplicate = _trace_dedupe.filter_new(
        current_session,
        [{"side": "gap", "trace": "", "eventId": shipment_id or f"dropped:{dropped}"}],
    ) if dropped else ([], 0)
    if dropped and gap_records:
        # The missing records happened before this batch.  Put the gap marker
        # first so a reader never mistakes the next line for a continuous path.
        trace.write(
            "api",
            "api/routes/logs.py",
            "ingest_trace",
            "!!",
            {"browserRecordsDropped": dropped},
        )

    written = trace.client(records)
    return {
        "ok": True,
        "written": written,
        "duplicates": duplicates + gap_duplicate,
        "dropped": dropped,
        "session": current_session,
        # Basename only. A browser needs the file identity, not the host's
        # absolute directory structure.
        "file": trace.file_name(),
    }


@router.get("/v1/logs/where")
async def where() -> dict:
    """Where the logs are, so nobody has to guess the path."""
    return {
        "ok": True,
        "enabled": logfile.is_enabled(),
        "dir": str(logfile.log_dir()),
        "files": sorted(p.name for p in logfile.log_dir().glob("*.log"))
        if logfile.log_dir().exists()
        else [],
    }
