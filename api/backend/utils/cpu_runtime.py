"""Container-aware CPU capacity helpers.

``os.cpu_count()`` reports the host CPU topology on some container runtimes,
which can be much larger than the cgroup quota actually assigned to the
process.  ONNX Runtime uses that number to size its native thread pools, so a
2-vCPU Space can accidentally create dozens of runnable threads and become
*slower* as concurrency increases.

Keep this module dependency-free and best-effort.  It is used at import/startup
and must never make the API fail merely because a cgroup file is absent.
"""
from __future__ import annotations

import math
import os
from typing import Any


def _read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except (OSError, ValueError):
        return ""


def _quota_v2() -> float | None:
    raw = _read("/sys/fs/cgroup/cpu.max")
    if not raw:
        return None
    parts = raw.split()
    if len(parts) < 2 or parts[0] == "max":
        return None
    try:
        quota = float(parts[0])
        period = float(parts[1])
    except (TypeError, ValueError):
        return None
    if quota <= 0 or period <= 0:
        return None
    return quota / period


def _quota_v1() -> float | None:
    q = _read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
    p = _read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    if not q or not p:
        return None
    try:
        quota = float(q)
        period = float(p)
    except (TypeError, ValueError):
        return None
    if quota <= 0 or period <= 0:
        return None
    return quota / period


def cpu_runtime_info() -> dict[str, Any]:
    """Return host/affinity/cgroup CPU observations and a safe integer limit."""
    host = max(1, int(os.cpu_count() or 1))
    affinity: int | None = None
    try:
        affinity = max(1, len(os.sched_getaffinity(0)))  # type: ignore[attr-defined]
    except (AttributeError, OSError, TypeError):
        pass

    quota = _quota_v2()
    cgroup = "v2" if quota is not None else "none"
    if quota is None:
        quota = _quota_v1()
        if quota is not None:
            cgroup = "v1"

    # Floor a fractional CPU quota instead of rounding/ceiling it: native ONNX
    # threads are long-running CPU workers and oversubscribing 1.5 quota as two
    # full workers is exactly the HF slowdown this helper exists to avoid.
    quota_int = max(1, int(math.floor(quota))) if quota is not None else None
    candidates = [host]
    if affinity is not None:
        candidates.append(affinity)
    if quota_int is not None:
        candidates.append(quota_int)
    effective = max(1, min(candidates))
    return {
        "host": host,
        "affinity": affinity,
        "quota": round(quota, 3) if quota is not None else None,
        "quotaInt": quota_int,
        "cgroup": cgroup,
        "effective": effective,
    }


def effective_cpu_count() -> int:
    return int(cpu_runtime_info()["effective"])
