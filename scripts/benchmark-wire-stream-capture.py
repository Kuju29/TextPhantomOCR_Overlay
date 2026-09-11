#!/usr/bin/env python3
"""Synthetic filesystem benchmark for opt-in SSE wire capture.

This measures local diagnostic overhead only. It does not measure provider,
network, first-content or translation latency.
"""
from __future__ import annotations

import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai import wire_trace
from backend.ai.transports.openai_chat import _WireStreamCapture


LINES = [f'data: {{"choices":[{{"delta":{{"content":"part-{i}"}}}}]}}\n'
         for i in range(512)] + ["data: [DONE]\n"]


def sample(enabled: bool, buffered: bool, root: Path, run: int) -> float:
    os.environ["TP_AI_WIRE_TRACE"] = "1" if enabled else "0"
    os.environ["TP_AI_WIRE_TRACE_DIR"] = str(root)
    token = wire_trace.begin({"traceId": f"b{run}", "operationId": "wire"})
    started = time.perf_counter()
    if buffered:
        capture = _WireStreamCapture()
        for line in LINES:
            capture.raw(line)
        capture.finish("visible")
    else:
        for line in LINES:
            wire_trace.append_text("05_provider_response.raw", line)
        wire_trace.assembled_response("visible")
    elapsed = (time.perf_counter() - started) * 1000
    wire_trace.end(token)
    return elapsed


with tempfile.TemporaryDirectory(prefix="tp-wire-bench-") as temp:
    root = Path(temp)
    cases = ((False, True, "trace-off buffered"),
             (True, False, "trace-on per-line baseline"),
             (True, True, "trace-on buffered"))
    for enabled, buffered, label in cases:
        values = [sample(enabled, buffered, root, i) for i in range(9)]
        median = statistics.median(values)
        p90 = sorted(values)[-1]
        print(f"{label}: median={median:.3f}ms p90={p90:.3f}ms")

print("CPU/filesystem-only synthetic benchmark; not provider or network evidence.")
