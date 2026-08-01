"""Really starts the API through ServerController, calls it, stops it, restarts it."""
from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import time
import urllib.request
from pathlib import Path

import tkstub

tkstub.install()

SANDBOX = Path("/tmp/tp-srv")
os.environ["XDG_DATA_HOME"] = str(SANDBOX)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import textphantom_launcher as L  # noqa: E402

API_SRC = Path(__file__).resolve().parent.parent.parent / "api"
FAILS: list[str] = []
STATES: list[tuple[str, str]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + (f"  {extra}" if extra else ""))
    if not cond:
        FAILS.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


L.ensure_dirs()
# Pretend an update installed this source into the cache.
shutil.rmtree(L.API_DIR, ignore_errors=True)
shutil.copytree(API_SRC, L.API_DIR,
                ignore=shutil.ignore_patterns("__pycache__", ".ruff_cache", "models"))
L.Updater(L.LogBus()).sync_assets()

bus = L.LogBus()
sys.stdout = L.StreamToBus(bus, sys.__stdout__)
ctl = L.ServerController(bus, lambda st, detail: STATES.append((st, detail)))

port = free_port()
settings = {
    **L.DEFAULT_SETTINGS,
    "host": "127.0.0.1",
    "port": port,
    "env": {"SERVER_MAX_WORKERS": "4", "TP_CPU_CONCURRENCY": "1",
            "TP_ACCESS_LOG_MODE": "summary", "TP_DEBUG": "true",
            "AI_API_KEY": "test-only-not-used"},
    "ai_temperature": "0.33",
    "ai_max_tokens": "4096",
    "prompt_overrides": {"th": "CUSTOM THAI PROMPT FOR TEST"},
}

print("\n== start ==")
ctl.start(settings, L.API_DIR)
deadline = time.time() + 90
health = None
while time.time() < deadline:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            health = json.loads(r.read())
        break
    except Exception:
        time.sleep(0.5)
check("/health answered", bool(health and health.get("ok")), str(health))
for _ in range(60):  # the badge flips from its own health watcher, a moment later
    if ctl.state == L.STATE_RUNNING:
        break
    time.sleep(0.2)
check("state went to running", ctl.state == L.STATE_RUNNING
      and any(s == L.STATE_RUNNING for s, _ in STATES), str([s for s, _ in STATES]))
check("uptime clock started", ctl.started_at > 0)
check("cwd is the runtime dir", Path(os.getcwd()) == L.RUNTIME_DIR, os.getcwd())

print("\n== the overrides really reached the running code ==")
import backend.ai.config as ai_config  # noqa: E402  (imported by the controller)
import backend.ai.prompts as prompts  # noqa: E402

check("TEMPERATURE overridden", ai_config.TEMPERATURE == 0.33, str(ai_config.TEMPERATURE))
check("MAX_TOKENS overridden", ai_config.MAX_TOKENS == 4096, str(ai_config.MAX_TOKENS))
check("prompt override active",
      prompts.lang_style("th") == "CUSTOM THAI PROMPT FOR TEST",
      prompts.lang_style("th")[:40])
check("other languages untouched", len(prompts.lang_style("ja")) > 50)

import backend.config as bconfig  # noqa: E402
check("env reached settings: workers", bconfig.settings.max_workers == 4,
      str(bconfig.settings.max_workers))
check("env reached settings: cpu gate", bconfig.settings.cpu_concurrency == 1)
check("env reached settings: debug on", bconfig.settings.debug is True)
check("model path is the shared runtime copy",
      bconfig.settings.textblock_model_path
      == str(L.RUNTIME_DIR / "models" / L.MODEL_NAME),
      bconfig.settings.textblock_model_path)

print("\n== other endpoints ==")
for path in ("/version", "/meta"):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
            payload = json.loads(r.read())
        check(f"{path} ok", bool(payload.get("ok")), str(payload)[:80])
    except Exception as exc:
        check(f"{path} ok", False, repr(exc))
try:
    with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/ai/prompt/default?lang=th", timeout=10) as r:
        payload = json.loads(r.read())
    check("/ai/prompt/default returns the override",
          payload.get("lang_style") == "CUSTOM THAI PROMPT FOR TEST",
          str(payload.get("lang_style"))[:40])
except Exception as exc:
    check("/ai/prompt/default returns the override", False, repr(exc))

print("\n== log capture ==")
lines = [ln for _lvl, ln in bus.drain(9999)]
check("startup line captured", any("starting build=" in ln for ln in lines),
      next((ln for ln in lines if "starting build=" in ln), ""))
check("uvicorn logging captured", any("Uvicorn running" in ln or "Started server" in ln
                                      for ln in lines),
      next((ln for ln in lines if "Uvicorn" in ln), ""))
check("override lines logged", any("override:" in ln for ln in lines))

print("\n== stop ==")
ctl.stop()
check("thread stopped", ctl.wait_stopped(30))
check("state is stopped", ctl.state == L.STATE_STOPPED, ctl.state)
time.sleep(0.5)
check("port released", not L.port_in_use("127.0.0.1", port))

print("\n== restart picks up new code (simulates an api update) ==")
target = L.API_DIR / "backend" / "api" / "routes" / "health.py"
target.write_text(target.read_text().replace(
    '"core": "backend.rewrite"', '"core": "PATCHED-BY-UPDATE"'), encoding="utf-8")
for cache in L.API_DIR.rglob("__pycache__"):
    shutil.rmtree(cache, ignore_errors=True)
port2 = free_port()
settings["port"] = port2
ctl.start(settings, L.API_DIR)
deadline = time.time() + 90
version = None
while time.time() < deadline:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port2}/version", timeout=2) as r:
            version = json.loads(r.read())
        break
    except Exception:
        time.sleep(0.5)
check("restarted on the new port", bool(version), str(version))
check("updated api code was re-imported (no stale modules)",
      bool(version) and version.get("core") == "PATCHED-BY-UPDATE", str(version))

print("\n== a cleared setting really goes away on the next start ==")
ctl.stop()
ctl.wait_stopped(30)
port3 = free_port()
settings["port"] = port3
settings["env"] = {k: v for k, v in settings["env"].items()
                   if k != "SERVER_MAX_WORKERS"}          # user emptied the field
ctl.start(settings, L.API_DIR)
deadline = time.time() + 90
while time.time() < deadline:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port3}/health", timeout=2).read()
        break
    except Exception:
        time.sleep(0.5)
check("SERVER_MAX_WORKERS removed from the environment",
      "SERVER_MAX_WORKERS" not in os.environ)
import backend.config as bconfig2  # noqa: E402  (fresh import after the purge)
check("api fell back to its own default (15)", bconfig2.settings.max_workers == 15,
      str(bconfig2.settings.max_workers))

print("\n== port conflict is refused clearly ==")
STATES.clear()
ctl2 = L.ServerController(bus, lambda st, d: STATES.append((st, d)))
ctl2.start({**settings, "port": port3}, L.API_DIR)
check("second server refused", any(s == L.STATE_ERROR for s, _ in STATES),
      str(STATES))
check("conflict explained in the log",
      any("already taken" in ln for _l, ln in bus.drain(999)))

print("\n== Stop pressed during 'Starting…' really stops ==")
STATES.clear()
ctl4 = L.ServerController(bus, lambda st, d: STATES.append((st, d)))
port4 = free_port()
ctl4.start({**settings, "port": port4}, L.API_DIR)
time.sleep(0.05)                      # still importing / booting
ctl4.stop()
check("thread finished", ctl4.wait_stopped(40))
check("ended in the stopped state", ctl4.state == L.STATE_STOPPED, ctl4.state)
time.sleep(0.5)
check("no orphan server left listening", not L.port_in_use("127.0.0.1", port4))

print("\n== single instance lock ==")
first = L.SingleInstance(L.DATA_DIR / "instance.lock")
check("first instance takes the lock", first.acquire())
second = L.SingleInstance(L.DATA_DIR / "instance.lock")
check("second instance is refused", second.acquire() is False)

print("\n== missing source is refused clearly ==")
STATES.clear()
ctl3 = L.ServerController(bus, lambda st, d: STATES.append((st, d)))
ctl3.start(settings, SANDBOX / "does-not-exist")
check("missing api refused", any(s == L.STATE_ERROR for s, _ in STATES), str(STATES))

ctl.stop()
ctl.wait_stopped(30)
sys.stdout = sys.__stdout__
print("\n" + ("ALL SERVER CHECKS PASSED" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}"))
sys.exit(1 if FAILS else 0)
