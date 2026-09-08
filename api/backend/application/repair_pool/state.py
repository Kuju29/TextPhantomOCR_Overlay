"""Pure transitions for repair manifests. No credentials, images or provider calls."""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any

MAX_PAGES = 512
MAX_UNITS = 4096
MAX_TEXT = 20_000
MAX_RUN_BYTES = 6 * 1024 * 1024

class PoolError(ValueError):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code, self.status = code, status

def identifier(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9:_.-]{1,160}", value):
        raise PoolError("invalid_repair_identifier", 400)
    return value

def count(value: Any) -> int:
    if value is None:
        return 0
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_UNITS:
        raise PoolError("invalid_repair_count", 400)
    return value

def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()

def source_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()

def new_run(run_id: str, manifest: Any, now: float) -> dict:
    if not isinstance(manifest, list) or not 1 <= len(manifest) <= MAX_PAGES:
        raise PoolError("invalid_repair_manifest", 400)
    manifest = [identifier(x) for x in manifest]
    if len(set(manifest)) != len(manifest):
        raise PoolError("duplicate_repair_page", 400)
    return {"id": identifier(run_id), "createdAt": now, "updatedAt": now,
            "phase": "collecting", "manifest": manifest, "pages": {}, "units": {},
            "tasks": {}, "round": 0}

def check_active(run: dict) -> None:
    if run["phase"] == "cancelled":
        raise PoolError("repair_run_cancelled")

def record_page(run: dict, body: dict) -> dict:
    check_active(run)
    page = identifier(body.get("pageId"))
    if page not in run["manifest"]:
        raise PoolError("repair_page_not_registered")
    status = body.get("status")
    if status not in ("finished", "no_source", "interrupted", "cancelled"):
        raise PoolError("invalid_initial_status", 400)
    generation = identifier(body.get("generationId"))
    group = str(body.get("groupKey") or "")
    if group and not re.fullmatch("[a-f0-9]{64}", group):
        raise PoolError("invalid_repair_group", 400)
    failed = body.get("failed", [])
    if not isinstance(failed, list) or len(failed) > MAX_UNITS:
        raise PoolError("too_many_repair_units", 413)
    if failed and (not group or status in ("cancelled", "no_source")):
        raise PoolError("invalid_repair_page_state", 400)
    rows, seen = [], set()
    for item in failed:
        if not isinstance(item, dict):
            raise PoolError("invalid_repair_unit", 400)
        unit_id = identifier(item.get("id"))
        text = item.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise PoolError("invalid_repair_source", 400)
        if unit_id in seen:
            raise PoolError("duplicate_repair_unit", 400)
        seen.add(unit_id)
        checksum = source_hash(text)
        if item.get("sourceHash") != checksum:
            raise PoolError("repair_source_hash_mismatch")
        reason = item.get("reason", "missing")
        if reason not in ("missing", "omitted", "empty", "wrong_language", "malformed", "length", "not_sent"):
            raise PoolError("invalid_repair_reason", 400)
        rows.append({"unitId": unit_id, "text": text, "sourceHash": checksum,
                     "reason": reason, "pageId": page, "generationId": generation,
                     "groupKey": group, "state": "pending"})
    incoming = {"pageId": page, "generationId": generation, "groupKey": group,
                "status": status, "failed": rows,
                "initialAccepted": count(body.get("initialAccepted")),
                "unverified": count(body.get("unverified"))}
    digest = fingerprint(incoming)
    old = run["pages"].get(page)
    if old:
        if old["digest"] != digest:
            raise PoolError("initial_page_already_finalized")
        return {"recorded": True, "replayed": True}
    if run["phase"] != "collecting":
        raise PoolError("repair_manifest_sealed")
    if len(run["units"]) + len(rows) > MAX_UNITS:
        raise PoolError("repair_pool_unit_limit", 413)
    for row in rows:
        alias = f"R{len(run['units'])}"
        run["units"][alias] = {"id": alias, **row}
    run["pages"][page] = {k: v for k, v in incoming.items() if k != "failed"}
    run["pages"][page]["digest"] = digest
    return {"recorded": True, "replayed": False}

def seal(run: dict) -> dict:
    check_active(run)
    if len(run["pages"]) != len(run["manifest"]):
        raise PoolError("initial_pass_not_complete")
    if run["phase"] == "collecting":
        run["round"] = 1
        run["phase"] = "repairing" if run["units"] else "done"
    return view(run)

def claim(run: dict, body: dict) -> dict:
    check_active(run)
    task_id, executor = identifier(body.get("taskId")), identifier(body.get("executor"))
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > 200 or any(not isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
        raise PoolError("invalid_repair_claim", 400)
    ids = [identifier(x) for x in ids]
    old = run["tasks"].get(task_id)
    if old:
        if old["ids"] != ids or old["executor"] != executor:
            raise PoolError("repair_claim_conflict")
        return task_view(run, old)
    if run["phase"] != "repairing":
        raise PoolError("repair_not_ready")
    rows = [run["units"].get(x) for x in ids]
    if any(not x or x["state"] != "pending" for x in rows):
        raise PoolError("repair_unit_already_attempted")
    if len({x["groupKey"] for x in rows}) != 1:
        raise PoolError("mixed_repair_settings")
    route = body.get("route")
    if route not in ("server", "direct-local"):
        raise PoolError("invalid_repair_executor", 400)
    task = {"id": task_id, "ids": ids, "executor": executor, "route": route,
            "state": "ready", "createdAt": time.time(), "answer": None}
    run["tasks"][task_id] = task
    for row in rows:
        row.update(state="claimed", taskId=task_id)
    return task_view(run, task)

def task_view(run: dict, task: dict) -> dict:
    return {**task, "units": [dict(run["units"][x]) for x in task["ids"]]}

def begin(run: dict, task_id: str, executor: str) -> dict:
    check_active(run)
    task = run["tasks"].get(identifier(task_id))
    if not task or task["executor"] != executor:
        raise PoolError("repair_task_not_owned")
    if task["state"] != "ready":
        return {"dispatch": False, **task_view(run, task)}
    task.update(state="running", startedAt=time.time())
    return {"dispatch": True, **task_view(run, task)}

def normalized_answer(answer: dict, ids: list[str]) -> dict:
    if not isinstance(answer, dict):
        raise PoolError("invalid_repair_answer", 400)
    rows = answer.get("translations", [])
    if not isinstance(rows, list):
        raise PoolError("invalid_repair_answer", 400)
    seen = set()
    clean = []
    for row in rows:
        key = row.get("id") if isinstance(row, dict) else None
        text = row.get("text") if isinstance(row, dict) else None
        if key not in ids or key in seen or not isinstance(text, str) or len(text) > MAX_TEXT:
            raise PoolError("invalid_repair_answer_identity", 400)
        seen.add(key)
        clean.append({"id": key, "text": text})
    # Persist normalized output/usage only, never the request/API key/raw prompt.
    meta = answer.get("meta") if isinstance(answer.get("meta"), dict) else {}
    safe_meta = {k: meta[k] for k in ("usage", "provider", "model", "finishReason", "finish_reason",
        "providerAttempts", "generationAttempts", "omittedIds", "declinedIds", "providerMs") if k in meta}
    return {"schema": "tp.ai.result/1", "translations": clean,
            "missing": [x for x in ids if x not in seen], "meta": safe_meta}

def answer_task(run: dict, task_id: str, answer: dict) -> dict:
    task = run["tasks"].get(identifier(task_id))
    if not task:
        raise PoolError("repair_task_not_found", 404)
    if run["phase"] == "cancelled":
        return {"accepted": False, "cancelled": True}
    clean = normalized_answer(answer, task["ids"])
    digest = fingerprint(clean)
    if task.get("answerHash"):
        if task["answerHash"] != digest:
            raise PoolError("repair_answer_conflict")
        return task_view(run, task)
    if task["state"] != "running":
        raise PoolError("repair_task_not_running")
    task.update(state="answered", answer=clean, answerHash=digest)
    return task_view(run, task)

def complete(run: dict, task_id: str, body: dict) -> dict:
    check_active(run)
    task = run["tasks"].get(identifier(task_id))
    if not task:
        raise PoolError("repair_task_not_found", 404)
    if task["route"] == "direct-local" and body.get("answer") is not None:
        answer_task(run, task_id, body["answer"])
    accepted = body.get("accepted", [])
    if not isinstance(accepted, list) or any(not isinstance(x, str) for x in accepted) or len(set(accepted)) != len(accepted):
        raise PoolError("invalid_repair_acceptance", 400)
    returned = {x["id"]: x["text"] for x in (task.get("answer") or {}).get("translations", [])}
    if any(x not in task["ids"] or not returned.get(x, "").strip() for x in accepted):
        raise PoolError("invalid_repair_acceptance", 400)
    accepted = sorted(accepted)
    if task["state"] == "done":
        if task["accepted"] != accepted:
            raise PoolError("repair_commit_conflict")
        return view(run)
    if task["state"] != "answered":
        raise PoolError("repair_answer_unavailable")
    task.update(state="done", accepted=accepted, completedAt=time.time())
    for alias in task["ids"]:
        row = run["units"][alias]
        row["state"] = "repaired" if alias in accepted else "unresolved"
        if alias in accepted:
            row["translation"] = returned[alias]
    settle(run)
    return view(run)

def fail(run: dict, task_id: str, reason: str, unknown: bool = False) -> dict:
    check_active(run)
    task = run["tasks"].get(identifier(task_id))
    if not task:
        raise PoolError("repair_task_not_found", 404)
    if task["state"] in ("done", "failed", "unknown"):
        return view(run)
    if task["state"] == "answered":
        raise PoolError("repair_answer_requires_validation")
    task.update(state="unknown" if unknown else "failed", reason=str(reason)[:120])
    for alias in task["ids"]:
        run["units"][alias]["state"] = "unknown" if unknown else "unresolved"
    settle(run)
    return view(run)

def settle(run: dict) -> None:
    if run["phase"] == "repairing" and all(x["state"] in ("repaired", "unresolved", "unknown") for x in run["units"].values()):
        run["phase"] = "done"

def cancel(run: dict) -> dict:
    run["phase"] = "cancelled"
    # Erase dialogue promptly; do not leave sensitive cancelled source in the ledger.
    for row in run["units"].values():
        row.pop("text", None)
        row.pop("translation", None)
        row["state"] = "cancelled"
    for task in run["tasks"].values():
        task["answer"] = None
        task["state"] = "cancelled"
    return view(run)

def view(run: dict) -> dict:
    rows = list(run["units"].values())
    return {"id": run["id"], "phase": run["phase"], "round": run["round"],
            "initialPages": len(run["pages"]), "expectedPages": len(run["manifest"]),
            "initialAccepted": sum(x["initialAccepted"] for x in run["pages"].values()),
            "unavailablePages": sum(x["status"] == "no_source" for x in run["pages"].values()),
            "unverified": sum(x["unverified"] for x in run["pages"].values()),
            "pending": [dict(x) for x in rows if x["state"] == "pending"],
            "results": [dict(x) for x in rows if x["state"] == "repaired"],
            "unresolved": sum(x["state"] in ("unresolved", "unknown") for x in rows),
            "failedUnits": len(rows), "repaired": sum(x["state"] == "repaired" for x in rows),
            "tasks": [task_view(run, x) for x in run["tasks"].values()]}
