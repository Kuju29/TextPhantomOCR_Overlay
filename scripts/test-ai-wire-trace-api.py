"""Executable contract checks for lossless runs:API AI wire evidence."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from backend.ai import wire_trace  # noqa: E402
from backend.ai import local_wire_relay  # noqa: E402
from backend.api.routes.local_wire_trace import router as local_wire_router  # noqa: E402

EXPECTED = {
    "00_identity.json", "01_units.json", "02_system_prompt.txt",
    "04_provider_request.json", "05_provider_response.raw",
    "05_provider_response.assembled.txt",
    "11_terminal.json",
    "06_parsed_records.json", "07_validation.json", "08_apply_result.json", "09_timing.json",
}

# Import-time contract: TP_AI_WIRE_TRACE alone must make the main trace compact
# and create process-level evidence. Run in a child process so module globals
# cannot inherit this test runner's environment/import state.
with tempfile.TemporaryDirectory(prefix="tp-wire-implies-trace-") as temp:
    env = dict(os.environ)
    env.pop("TP_TRACE", None)
    env["TP_AI_WIRE_TRACE"] = "1"
    env["TP_TRACE_DIR"] = str(Path(temp) / "trace")
    env["TP_AI_WIRE_TRACE_DIR"] = str(Path(temp) / "wire")
    env["PYTHONPATH"] = str(ROOT / "api")
    code = """
from pathlib import Path
import os
from backend import trace
from backend.ai import wire_trace
assert trace.enabled() and trace.mode() == 'compact', (trace.enabled(), trace.mode())
trace.start_session()
state = wire_trace.start_session()
assert state['enabled'] is True
trace.flush()
assert list(Path(state['root']).glob('_session-*.json'))
trace_files = list(Path(os.environ['TP_TRACE_DIR']).glob('trace-*.jsonl'))
assert trace_files
text = trace_files[0].read_text('utf-8')
assert '"fn": "session_start"' in text and '"aiWireTrace": true' in text
"""
    child = subprocess.run([sys.executable, "-c", code], env=env, text=True, capture_output=True)
    assert child.returncode == 0, child.stderr or child.stdout

with tempfile.TemporaryDirectory(prefix="tp-wire-api-") as temp:
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp)
    try:
        token = wire_trace.begin({
            "schema": "tp.ai-wire-trace/1", "engine": "runs:API",
            "traceId": "trace-one", "operationId": "operation-one", "imageId": "image-one",
            "provider": "openrouter", "model": "model-one", "generationAttempt": 1,
        })
        wire_trace.write_json("01_units.json", [{"id": "g0", "text": "原文"}])
        wire_trace.write_text("02_system_prompt.txt", "SYSTEM-จริง")
        wire_trace.provider_request(
            url="https://provider.invalid/generate?key=do-not-leak&mode=real",
            headers={"Authorization": "Bearer do-not-leak", "Content-Type": "application/json"},
            payload={"contents": [{"text": "<<TP_P0:原文>>"}], "api_key": "do-not-leak"},
        )
        wire_trace.provider_response('{"text":"<<TP_P0:คำแปล>>"}')
        wire_trace.assembled_response("<<TP_P0:คำแปล>>")
        wire_trace.write_json("06_parsed_records.json", {"records": [{"id": "g0", "text": "คำแปล"}]})
        wire_trace.write_json("07_validation.json", {
            "missingIds": [], "wrongLanguageIds": ["g0"], "duplicateIds": [], "extraIds": [],
        })
        wire_trace.write_json("08_apply_result.json", {"appliedIds": ["g0"]})
        wire_trace.write_json("09_timing.json", {"generationAttempts": 1, "providerMs": 12})
        wire_trace.terminal(state="succeeded", stage="validation", translated=1)
        wire_trace.end(token)

        folder = Path(temp) / "trace-one--operation-one"
        assert EXPECTED == {item.name for item in folder.iterdir()}
        assert (folder / "02_system_prompt.txt").read_text(encoding="utf-8") == "SYSTEM-จริง"
        assert (folder / "05_provider_response.raw").read_text(encoding="utf-8") == '{"text":"<<TP_P0:คำแปล>>"}'
        assert (folder / "05_provider_response.assembled.txt").read_text(encoding="utf-8") == "<<TP_P0:คำแปล>>"
        request = json.loads((folder / "04_provider_request.json").read_text(encoding="utf-8"))
        assert "do-not-leak" not in json.dumps(request, ensure_ascii=False)
        assert request["body"]["contents"][0]["text"] == "<<TP_P0:原文>>"
        validation = json.loads((folder / "07_validation.json").read_text(encoding="utf-8"))
        assert validation["missingIds"] == []
        assert validation["wrongLanguageIds"] == ["g0"]
        assert json.loads((folder / "09_timing.json").read_text(encoding="utf-8"))["generationAttempts"] == 1
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

with tempfile.TemporaryDirectory(prefix="tp-wire-api-fail-") as temp:
    blocker = Path(temp) / "not-a-directory"
    blocker.write_text("block", encoding="utf-8")
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=str(blocker))
    try:
        try:
            wire_trace.begin({"traceId": "trace", "operationId": "operation"})
            raise AssertionError("unwritable trace destination must fail visibly")
        except wire_trace.AiWireTraceWriteError as exc:
            assert exc.code == "AI_WIRE_TRACE_WRITE_FAILED"
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

with tempfile.TemporaryDirectory(prefix="tp-wire-provider-fail-") as temp:
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp)
    try:
        token = wire_trace.begin({
            "schema": "tp.ai-wire-trace/1", "engine": "runsapi",
            "traceId": "trace-failure", "operationId": "operation-failure",
        })
        wire_trace.provider_request(
            url="http://localhost:11434/api/chat", headers={"Authorization": "Bearer hidden-local-key"},
            payload={"model": "qwen", "messages": [{"role": "user", "content": "จริง"}]},
        )
        wire_trace.append_text("05_provider_response.raw", '{"message":{"content":"<<TP_P0:บางส่วน","debug":"Bearer hidden-local-key"}')
        wire_trace.append_assembled("<<TP_P0:บางส่วน")
        failure = RuntimeError("transport failed ?key=must-not-leak")
        wire_trace.record_error(failure, stage="provider_stream")
        wire_trace.write_json("09_timing.json", {"providerMs": 42, "completed": False})
        wire_trace.end(token)

        folder = Path(temp) / "trace-failure--operation-failure"
        assert (folder / "00_identity.json").exists()
        assert (folder / "04_provider_request.json").exists()
        partial = (folder / "05_provider_response.raw").read_text("utf-8")
        assert "บางส่วน" in partial
        assert "hidden-local-key" not in partial
        assert (folder / "05_provider_response.assembled.txt").read_text("utf-8") == "<<TP_P0:บางส่วน"
        error = json.loads((folder / "10_error.json").read_text("utf-8"))
        assert error["stage"] == "provider_stream"
        terminal = json.loads((folder / "11_terminal.json").read_text("utf-8"))
        assert terminal["terminal"] is True and terminal["state"] == "failed"
        assert terminal["stage"] == "provider_stream"
        assert "must-not-leak" not in json.dumps(error)
        assert json.loads((folder / "09_timing.json").read_text("utf-8"))["completed"] is False
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

# Keep both engine owners connected to the same artifact contract. These are
# intentionally structural checks; provider calls remain covered by the
# provider matrix and must not run during the unit suite.
runsapi_request = (ROOT / "api/backend/application/translate_request.py").read_text(encoding="utf-8")
extension_route = (ROOT / "api/backend/application/ai_translation/orchestration.py").read_text(encoding="utf-8")
api_validation = (ROOT / "api/backend/jobs/stages/ai_repair.py").read_text(encoding="utf-8")
api_apply = (ROOT / "api/backend/jobs/stages/ai_stage.py").read_text(encoding="utf-8")
for engine, source in (("runsapi", runsapi_request), ("runsextension", extension_route)):
    assert "wire_trace.begin" in source, f"{engine} must establish an AI wire trace scope"
    assert f'"engine": "{engine}"' in source, f"{engine} identity must not be mislabeled"
assert 'wire_trace.write_json("07_validation.json"' in api_validation
assert '"wrongLanguageIds"' in api_validation and '"missingIds"' in api_validation
assert 'wire_trace.write_json("08_apply_result.json"' in api_apply

with tempfile.TemporaryDirectory(prefix="tp-local-wire-relay-") as temp:
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp)
    try:
        cap = local_wire_relay.capability()
        assert cap and cap["token"] and cap["path"].endswith("/local-wire-trace")
        identity = {"traceId": "trace-local", "operationId": "ai:image", "executionKey": "run-1",
                    "provider": "ollama", "model": "qwen", "route": "direct-local"}
        local_wire_relay.receive({"identity": identity, "stage": "trace_started", "value": None})
        local_wire_relay.receive({"identity": identity, "stage": "systemPrompt", "value": "SYSTEM exact"})
        local_wire_relay.receive({"identity": identity, "stage": "providerRequest", "value": {
            "url": "http://127.0.0.1:11434/api/chat", "headers": {"Authorization": "<redacted>"},
            "body": {"model": "qwen", "messages": [{"content": "<<TP_P0:原文>>"}]}}})
        local_wire_relay.receive({"identity": identity, "stage": "contractSelection", "value": {
            "selectedContract": "tp.translation.schema-object/1"}})
        local_wire_relay.receive({"identity": identity, "stage": "providerResponse", "value": {
            "chunks": ['{"message":{"content":"<<TP_P0:ไทย>>"}}\n'], "complete": True}})
        local_wire_relay.receive({"identity": identity, "stage": "contractApplied", "value": {
            "selectedContract": "tp.translation.schema-object/1"}})
        local_wire_relay.receive({"identity": identity, "stage": "failure", "value": {
            "stage": "validation", "code": "wrong_language_output",
            "terminal": False, "state": "succeeded"}})
        folder = next(Path(temp).iterdir())
        assert json.loads((folder / "00_identity.json").read_text("utf-8"))["runtime"] == "direct-local"
        assert (folder / "02_system_prompt.txt").read_text("utf-8") == "SYSTEM exact"
        assert "TP_P0:原文" in (folder / "04_provider_request.json").read_text("utf-8")
        assert "TP_P0:ไทย" in (folder / "05_provider_response.raw").read_text("utf-8")
        assert (folder / "04_contract_selection.json").exists()
        assert (folder / "08_contract_applied.json").exists()
        failed_terminal = json.loads((folder / "11_terminal.json").read_text("utf-8"))
        assert failed_terminal["state"] == "failed" and failed_terminal["terminal"] is True
        assert str(folder) in local_wire_relay._operation_sizes
        bytes_after_failure = local_wire_relay._operation_sizes[str(folder)][0]
        local_wire_relay.receive({"identity": identity, "stage": "timing", "value": {
            "providerMs": 42, "failed": True}})
        assert local_wire_relay._operation_sizes[str(folder)][0] > bytes_after_failure
        local_wire_relay.receive({"identity": identity, "stage": "terminal", "value": {
            "state": "failed", "complete": False}})
        assert str(folder) not in local_wire_relay._operation_sizes
        try:
            local_wire_relay.receive({"identity": identity, "stage": "../../escape", "value": "x"})
            raise AssertionError("arbitrary relay stages must be rejected")
        except ValueError:
            pass
    finally:
        for key, value in previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value

# Slow trace persistence must overlap across requests instead of occupying the
# FastAPI event-loop thread serially.
with tempfile.TemporaryDirectory(prefix="tp-local-wire-concurrency-") as temp:
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp)
    original_receive = local_wire_relay.receive
    try:
        def slow_receive(payload):
            time.sleep(0.15)
            return Path(temp)
        local_wire_relay.receive = slow_receive
        app = FastAPI()
        app.include_router(local_wire_router)
        cap = local_wire_relay.capability()
        def post(index):
            identity = {"traceId": f"t{index}", "operationId": f"o{index}",
                        "executionKey": f"e{index}", "route": "direct-local"}
            with TestClient(app) as client:
                return client.post(cap["path"], headers={
                    "X-TP-AI-Wire-Capability": cap["token"],
                    "X-TP-Trace-Id": identity["traceId"],
                    "X-TP-Request-Id": identity["operationId"],
                    "X-TP-Job-Id": "", "X-TP-Batch-Id": "", "X-TP-Image-Id": "",
                }, json={"identity": identity, "stage": "trace_started", "value": None}).status_code
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(post, range(4)))
        elapsed = time.monotonic() - started
        assert statuses == [202] * 4
        assert elapsed < 0.45, f"relay filesystem calls serialized on event loop ({elapsed:.3f}s)"
    finally:
        local_wire_relay.receive = original_receive
        for key, value in previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value

with tempfile.TemporaryDirectory(prefix="tp-local-wire-ttl-") as temp:
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp)
    try:
        with local_wire_relay._lock:
            local_wire_relay._operation_sizes.clear()
            local_wire_relay._operation_sizes["expired"] = (
                1, time.monotonic() - local_wire_relay.OPERATION_TTL_SECONDS - 1,
            )
            for index in range(local_wire_relay.MAX_TRACKED_OPERATIONS):
                local_wire_relay._operation_sizes[f"live-{index}"] = (1, time.monotonic() + index)
        identity = {"traceId": "ttl", "operationId": "ttl", "executionKey": "ttl"}
        local_wire_relay.receive({"identity": identity, "stage": "trace_started", "value": None})
        assert "expired" not in local_wire_relay._operation_sizes
        assert len(local_wire_relay._operation_sizes) <= local_wire_relay.MAX_TRACKED_OPERATIONS
        local_wire_relay.receive({"identity": identity, "stage": "terminal", "value": {
            "state": "partial", "terminal": False,
        }})
        terminal = json.loads((next(Path(temp).iterdir()) / "11_terminal.json").read_text("utf-8"))
        assert terminal["terminal"] is True and terminal["state"] == "partial"
        assert all("--ttl--ttl" not in key for key in local_wire_relay._operation_sizes)
    finally:
        for key, value in previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value

print("API AI wire trace contract passed: both engines, exact content, redaction and distinct diagnostics.")

# Production-near emitter vocabulary -> HTTP receiver contract. Every stage
# emitted by the extension must be accepted, while an unknown stage fails.
with tempfile.TemporaryDirectory(prefix="tp-local-wire-http-") as temp:
    previous = {key: os.environ.get(key) for key in ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
    os.environ.update(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp)
    try:
        app = FastAPI()
        app.include_router(local_wire_router)
        client = TestClient(app)
        cap = local_wire_relay.capability()
        identity = {"traceId": "trace-http", "operationId": "op-http",
                    "executionKey": "exec-http", "route": "direct-local"}
        headers = {"X-TP-AI-Wire-Capability": cap["token"],
                   "X-TP-Trace-Id": identity["traceId"],
                   "X-TP-Request-Id": identity["operationId"],
                   "X-TP-Job-Id": "", "X-TP-Batch-Id": "", "X-TP-Image-Id": ""}
        stages = ["trace_started", *local_wire_relay.STAGE_FILES]
        for stage in stages:
            if stage in {"systemPrompt", "userPrompt"}:
                value = "text"
            elif stage == "providerResponse":
                value = {"chunks": ["raw\n"], "complete": True}
            elif stage == "providerAssembled":
                value = {"text": "assembled", "complete": True}
            else:
                value = {"stage": stage}
            response = client.post(cap["path"], headers=headers, json={
                "schema": "tp.ai-wire-trace/1", "identity": identity,
                "stage": stage, "value": value,
            })
            assert response.status_code == 202, (stage, response.status_code, response.text)
        folder = next(Path(temp).iterdir())
        assert str(folder) not in local_wire_relay._operation_sizes
        rejected = client.post(cap["path"], headers=headers, json={
            "schema": "tp.ai-wire-trace/1", "identity": identity,
            "stage": "unknownStage", "value": {},
        })
        assert rejected.status_code == 422
        mismatched = client.post(cap["path"], headers={**headers, "X-TP-Trace-Id": "other"}, json={
            "schema": "tp.ai-wire-trace/1", "identity": identity,
            "stage": "trace_started", "value": {},
        })
        assert mismatched.status_code == 422
        empty_bypass = client.post(cap["path"], headers=headers, json={
            "schema": "tp.ai-wire-trace/1",
            "identity": {**identity, "imageId": "nonempty-body-image"},
            "stage": "trace_started", "value": {},
        })
        assert empty_bypass.status_code == 422
        omitted_header = client.post(cap["path"], headers={
            key: value for key, value in headers.items() if key != "X-TP-Image-Id"
        }, json={"schema": "tp.ai-wire-trace/1", "identity": identity,
                 "stage": "trace_started", "value": {}})
        assert omitted_header.status_code == 422
    finally:
        for key, value in previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value
