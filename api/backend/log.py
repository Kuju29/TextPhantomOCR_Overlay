"""Small logging helpers used across the backend.


Production defaults are intentionally quiet: no uvicorn access spam, no health
polls, and no debug payload dumps.  ``event`` emits one compact JSON line for
important outcomes only (for example a translation job finishing or failing).
``dbg`` remains available for deep troubleshooting when ``TP_DEBUG=1``.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from backend import logfile
from backend.config import settings

_MAX_PAYLOAD_CHARS = 2000
# Modes that emit a line for EVERY outcome, success and failure alike.
_EVENT_MODES = {"summary", "custom", "tp", "plain"}
# Modes that emit ONLY failures (``ok=False``).
#
# This exists because "off" is a bad trade on a busy server. Successful jobs are
# ~99% of the lines, so silencing them removes essentially all of the logging
# cost — including the risk of a blocking write on the asyncio event loop, since
# every event() call runs on it. Failures are rare by definition and are the
# only lines anyone reads when something breaks, so keeping them costs nothing
# and is the difference between diagnosing the next problem and guessing at it.
_ERROR_ONLY_MODES = {"errors", "error", "err", "warn", "warnings"}

# Thailand is UTC+7 year-round (no DST).
_TH_TZ = timezone(timedelta(hours=7))


def _ts() -> str:
    """Current time in Thailand, e.g. ``[2026-06-11 01:41:11]``."""
    return datetime.now(_TH_TZ).strftime("[%Y-%m-%d %H:%M:%S]")


def _json(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, default=str, separators=(",", ":"))
    if len(text) > _MAX_PAYLOAD_CHARS:
        text = text[:_MAX_PAYLOAD_CHARS] + "…"
    return text


def event(tag: str, data: Any | None = None, *, ok: bool = True) -> None:
    """Emit one compact production log line for an important outcome.

    Controlled by ``TP_ACCESS_LOG_MODE``:
    - ``summary`` / ``custom`` / ``tp`` / ``plain``: emit these compact lines.
    - ``errors`` / ``error`` / ``err`` / ``warn``: emit ONLY failures. The
      recommended setting for a loaded deployment — it drops ~99% of the lines
      while keeping every line that explains a problem.
    - ``off`` / ``none``: emit nothing except explicit startup prints and fatal
      process errors. Note this hides FAILURES too, not just successes.
    - ``uvicorn``: do not duplicate uvicorn's own access log.
    """
    # The FILE gets every event regardless of the console mode. The console
    # setting exists to keep a loaded server quiet; the file exists to answer
    # "what happened" afterwards, and a quiet console is exactly the situation
    # where that question cannot be answered any other way.
    logfile.api(tag, data if isinstance(data, dict) else ({"data": data} if data is not None else None), ok=ok)

    mode = settings.access_log_mode
    if mode in _ERROR_ONLY_MODES:
        if ok:
            return
    elif mode not in _EVENT_MODES:
        return
    level = "ok" if ok else "err"
    try:
        if data is None:
            print(f"{_ts()} [TextPhantom][{level}] {tag}", flush=True)
        else:
            print(f"{_ts()} [TextPhantom][{level}] {tag} {_json(data)}", flush=True)
    except Exception:
        # Logging must never break request handling.
        pass


def dbg(tag: str, data: Any | None = None) -> None:
    """Print a tagged debug line only when ``TP_DEBUG`` is enabled.

    The file always gets it. Debug lines are the ones that explain a decision,
    and needing to reproduce a problem with TP_DEBUG=1 to find out why it
    happened means the first occurrence taught us nothing.
    """
    logfile.write(
        "api",
        {
            "side": "api",
            "tag": tag,
            "level": "debug",
            **(data if isinstance(data, dict) else ({"data": data} if data is not None else {})),
        },
    )
    if not settings.debug:
        return
    try:
        if data is None:
            print(f"{_ts()} [TextPhantom][dbg] {tag}", flush=True)
            return
        print(f"{_ts()} [TextPhantom][dbg] {tag} {_json(data)}", flush=True)
    except Exception:
        # Last-resort: don't let logging break a request.
        try:
            print(f"{_ts()} [TextPhantom][dbg] {tag} {data!r}", flush=True)
        except Exception:
            pass
