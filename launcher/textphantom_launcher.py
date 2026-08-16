#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TextPhantom Local API — desktop launcher (single file, EN/TH).

WHAT THIS IS
------------
A self-contained control panel that runs the TextPhantom OCR API **locally**
on the user's own machine, so nobody has to share the public Hugging Face
Space.  It is deliberately split in two halves:

* **This launcher** (compiled to one .exe) owns the window, the settings, the
  log view and the Python runtime + wheels (fastapi / uvicorn / numpy / cv2 /
  Pillow / budoux / onnxruntime).  It should never need to be rebuilt for a
  normal API change.
* **The API source** is *not* baked into the exe.  It is fetched from a GitHub
  URL the user can edit and kept in a private cache directory
  (``%LOCALAPPDATA%\\TextPhantomLocalAPI``) — never next to the .exe.  Press
  *Check update* and the newest ``api/`` folder from the repo is used on the
  next start.

The settings page is generated from the cached API itself: every
``os.environ`` / ``_env_*`` knob found in the downloaded source shows up as an
editable field.  That is what makes "no UI update needed later" true — new API
options appear in this UI automatically.

RUN FROM SOURCE
---------------
    pip install -r requirements-launcher.txt
    python textphantom_launcher.py

BUILD THE ONE-FILE EXE
----------------------
    build_exe.bat            (see ../README.md#desktop-launcher for details)
"""

from __future__ import annotations

import ast
import ctypes
import importlib
import io
import json
import logging
import os
import platform
import queue
import re
import shutil
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

APP_NAME = "TextPhantom Local API"
LAUNCHER_VERSION = "1.0.0"
DEFAULT_SOURCE = "https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/main/api"
USER_AGENT = f"TextPhantomLocalAPI/{LAUNCHER_VERSION} (+launcher)"
HTTP_TIMEOUT = 60


# Paths — everything the app writes lives in ONE private directory.
# Nothing is ever created next to the executable.
def _base_data_dir() -> Path:
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        root = str(Path.home() / "Library" / "Application Support")
    else:
        root = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(root) / "TextPhantomLocalAPI"


DATA_DIR = _base_data_dir()
API_DIR = DATA_DIR / "api"            # the cached api/ folder from GitHub
RUNTIME_DIR = DATA_DIR / "runtime"    # cwd of the server: fonts + onnx model land here
TMP_DIR = DATA_DIR / "tmp"
SETTINGS_FILE = DATA_DIR / "settings.json"
INSTALL_FILE = DATA_DIR / "install.json"

MODEL_NAME = "manga-bubble-yolo.onnx"
MODEL_URL_DEFAULT = (
    "https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/onnx/yolo26s.onnx"
)


def ensure_dirs() -> None:
    for p in (DATA_DIR, RUNTIME_DIR, RUNTIME_DIR / "models", TMP_DIR):
        p.mkdir(parents=True, exist_ok=True)


def cleanup_tmp(log: "LogBus | None" = None) -> int:
    """Delete leftovers from an interrupted download / update.

    Closing the window mid-download leaves a ``.part`` file, and a crash
    between the two renames can leave an ``api_old_*`` folder.  Neither is
    ever reused, so they are removed at startup instead of quietly growing.
    """
    removed = 0
    if not TMP_DIR.is_dir():
        return 0
    for item in TMP_DIR.iterdir():
        if item.name.startswith("api_old_") or item.suffix == ".part" \
                or item.name == "staging":
            try:
                shutil.rmtree(item) if item.is_dir() else item.unlink()
                removed += 1
            except OSError as exc:
                if log is not None:
                    log.emit(f"cleanup: could not remove {item.name} ({exc})", "warn")
    if removed and log is not None:
        log.emit(f"cleanup: removed {removed} leftover item(s) from tmp", "dbg")
    return removed


# Dependency pre-load.
#
# The API source is imported dynamically at runtime, so PyInstaller cannot see
# its imports.  Listing them here in real ``import`` statements makes the
# frozen build pick up the wheels + their hooks, and warming them in a
# background thread makes the first server start fast.
def _static_dependency_manifest() -> None:  # pragma: no cover - never called
    """Real ``import`` statements so PyInstaller bundles the API's wheels.

    The API source is imported dynamically at runtime, so the frozen build has
    no other way to know these packages are needed.  PyInstaller analyses
    bytecode, which means an uncalled function still counts.
    """
    import budoux  # noqa: F401
    import cv2  # noqa: F401
    import fastapi  # noqa: F401
    import h11  # noqa: F401
    import httpx  # noqa: F401
    import numpy  # noqa: F401
    import onnxruntime  # noqa: F401
    import PIL.Image  # noqa: F401
    import uvicorn  # noqa: F401
    import websockets  # noqa: F401


def preload_runtime_deps(log: "LogBus") -> None:
    """Import the heavy wheels up front and report anything missing."""
    ok, missing = [], []
    for name in (
        "fastapi", "uvicorn", "httpx", "numpy", "PIL", "cv2", "budoux",
        "onnxruntime", "websockets", "h11",
    ):
        try:
            importlib.import_module(name)
            ok.append(name)
        except Exception as exc:  # noqa: BLE001 - report, never crash the UI
            missing.append(f"{name} ({type(exc).__name__})")
    log.emit(f"runtime: loaded {', '.join(ok)}", "dbg")
    if missing:
        log.emit(
            "runtime: MISSING packages -> " + ", ".join(missing)
            + " | the server cannot start without them",
            "err",
        )


# Log bus + stdout/stderr capture
LEVELS = ("info", "ok", "warn", "err", "dbg")


def _guess_level(line: str) -> str:
    low = line.lower()
    if "[err]" in low or "traceback" in low or " error" in low or "error:" in low:
        return "err"
    if "warning" in low or "[warn]" in low:
        return "warn"
    if "[dbg]" in low:
        return "dbg"
    if "[ok]" in low:
        return "ok"
    return "info"


class LogBus:
    """Thread-safe line queue drained by the Tk main loop."""

    def __init__(self, maxsize: int = 20000) -> None:
        self._q: "queue.Queue[tuple[str, str]]" = queue.Queue(maxsize=maxsize)

    def emit(self, text: str, level: str = "info") -> None:
        stamp = time.strftime("%H:%M:%S")
        for line in str(text).splitlines() or [""]:
            try:
                self._q.put_nowait((level, f"[{stamp}] {line}"))
            except queue.Full:
                pass

    def emit_raw(self, line: str) -> None:
        self.emit(line, _guess_level(line))

    def drain(self, limit: int = 500) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        for _ in range(limit):
            try:
                out.append(self._q.get_nowait())
            except queue.Empty:
                break
        return out


class StreamToBus(io.TextIOBase):
    """File-like object that funnels the API's ``print`` output into the UI.

    A windowed (``--noconsole``) build has ``sys.stdout is None``, so this also
    keeps third-party code that writes to stdout from misbehaving.
    """

    def __init__(self, bus: LogBus, mirror: Any = None) -> None:
        self._bus = bus
        self._mirror = mirror
        self._buf = ""
        self._lock = threading.Lock()

    # -- text stream protocol
    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    @property
    def encoding(self) -> str:
        return "utf-8"

    def write(self, s: str) -> int:  # type: ignore[override]
        if not s:
            return 0
        with self._lock:
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.strip():
                    self._bus.emit_raw(line.rstrip())
        if self._mirror is not None:
            try:
                self._mirror.write(s)
            except Exception:
                pass
        return len(s)

    def flush(self) -> None:  # type: ignore[override]
        with self._lock:
            if self._buf.strip():
                self._bus.emit_raw(self._buf.rstrip())
            self._buf = ""
        if self._mirror is not None:
            try:
                self._mirror.flush()
            except Exception:
                pass


# Settings
@dataclass(frozen=True)
class FieldSpec:
    """One editable setting mapped to an API environment variable."""

    key: str                 # environment variable name
    group: str               # server | ai | pipeline | logging
    en: str
    th: str
    kind: str = "str"        # str | int | float | bool | choice | secret
    default: str = ""        # shown as the placeholder / API default
    choices: tuple[str, ...] = ()
    hint_en: str = ""
    hint_th: str = ""


CURATED: tuple[FieldSpec, ...] = (
    # --- server ------------------------------------------------------------
    FieldSpec("SERVER_MAX_WORKERS", "server", "Total workers (parallel jobs)",
              "จำนวน worker รวม (งานที่รันพร้อมกัน)", "int", "15",
              hint_en="Total processing budget. 4–8 is plenty on a home PC.",
              hint_th="โควตางานรวมทั้งหมด เครื่องบ้านทั่วไปใช้ 4–8 ก็พอ"),
    FieldSpec("TP_AI_MAX_CONCURRENCY", "server", "AI lane workers",
              "worker เลน AI", "int", "auto",
              hint_en="Jobs using the AI layer. 0 = automatic split.",
              hint_th="งานที่ใช้เลเยอร์ AI, 0 = แบ่งอัตโนมัติ"),
    FieldSpec("TP_DIRECT_MAX_CONCURRENCY", "server", "Lens lane workers",
              "worker เลน Lens", "int", "auto",
              hint_en="Jobs using Lens directly. 0 = automatic split.",
              hint_th="งานที่ใช้ Lens ตรงๆ, 0 = แบ่งอัตโนมัติ"),
    FieldSpec("TP_CPU_CONCURRENCY", "server", "CPU-heavy stages at once",
              "งานหนัก CPU พร้อมกัน", "int", "2",
              hint_en="Render/ONNX gate. Roughly half your CPU cores.",
              hint_th="ลิมิตงาน render/ONNX ประมาณครึ่งของจำนวนคอร์"),
    FieldSpec("TP_JOB_RUN_TIMEOUT_SEC", "server", "Per-job timeout (s)",
              "หมดเวลาต่อ 1 งาน (วินาที)", "float", "120"),
    FieldSpec("TP_MAX_QUEUE_SIZE", "server", "Max queued jobs",
              "คิวสูงสุด", "int", "2000"),
    FieldSpec("HTTP_TIMEOUT_SEC", "server", "Outbound HTTP timeout (s)",
              "หมดเวลา HTTP ขาออก (วินาที)", "float", "120"),
    # --- ai ----------------------------------------------------------------
    FieldSpec("AI_API_KEY", "ai", "AI API key", "คีย์ AI (API key)", "secret", "",
              hint_en="Used when the extension sends no key of its own.",
              hint_th="ใช้เมื่อส่วนขยายไม่ได้ส่งคีย์มาเอง"),
    FieldSpec("TP_RATE_GATE", "ai", "Rate gate (pace provider calls)",
              "ตัวหน่วงเรตลิมิต", "bool", "true"),
    FieldSpec("TP_RATE_RPM_DEFAULT", "ai", "Default requests / minute",
              "จำนวนรีเควสต์ต่อนาที (ค่าเริ่มต้น)", "float", "30"),
    FieldSpec("TP_RATE_MAX_WAIT_SEC", "ai", "Max wait in rate gate (s)",
              "รอในคิวเรตลิมิตสูงสุด (วินาที)", "float", "75"),
    FieldSpec("TP_GEMINI_THINKING", "ai", "Gemini thinking",
              "โหมดคิดของ Gemini", "choice", "default",
              choices=("default", "off", "on")),
    FieldSpec("TP_GEMINI_THINKING_LEVEL", "ai", "Gemini thinking level",
              "ระดับการคิดของ Gemini", "choice", "low",
              choices=("low", "medium", "high")),
    # --- pipeline ----------------------------------------------------------
    FieldSpec("TP_AI_LAYOUT_MODE", "pipeline", "AI layout mode",
              "โหมดจัดเลย์เอาต์ของ AI", "choice", "auto",
              choices=("auto", "fast", "quality"),
              hint_en="fast = never run ONNX, quality = always.",
              hint_th="fast = ไม่รัน ONNX เลย, quality = รันทุกครั้ง"),
    FieldSpec("TP_RELAYOUT_TRANSLATED", "pipeline", "Re-layout translated layer",
              "จัดเลย์เอาต์ใหม่ในเลเยอร์แปล", "bool", "true"),
    FieldSpec("TP_TEXTBLOCK_POOL_SIZE", "pipeline", "ONNX sessions",
              "จำนวนเซสชัน ONNX", "int", "1",
              hint_en="1 is fastest unless you have many spare cores.",
              hint_th="ปกติ 1 เร็วสุด ยกเว้นมีคอร์เหลือเยอะ"),
    FieldSpec("TP_TEXTBLOCK_WARMUP", "pipeline", "Load ONNX model at start",
              "โหลดโมเดล ONNX ตอนเริ่ม", "bool", "false",
              hint_en="Slower boot, faster first AI page.",
              hint_th="เปิดช้าลงเล็กน้อย แต่หน้าแรกที่ใช้ AI เร็วขึ้น"),
    FieldSpec("TP_VERTICAL_ROI", "pipeline", "Vertical ROI cropping",
              "ครอปข้อความแนวตั้ง (ROI)", "bool", "true"),
    FieldSpec("TP_WARMUP_LANG", "pipeline", "Warmup language",
              "ภาษาที่อุ่นเครื่อง", "str", "th"),
    FieldSpec("TP_LENS_DIRECT_ERASE", "pipeline", "Erase original text (Lens layers)",
              "ลบข้อความเดิม (เลเยอร์ Lens)", "bool", "true"),
    # --- logging -----------------------------------------------------------
    FieldSpec("TP_ACCESS_LOG_MODE", "logging", "Log mode",
              "โหมดบันทึก log", "choice", "summary",
              choices=("summary", "uvicorn", "off")),
    FieldSpec("TP_DEBUG", "logging", "Debug log",
              "log แบบละเอียด (debug)", "bool", "false"),
)

CURATED_KEYS = {f.key for f in CURATED}
GROUP_TITLES = {
    "server": ("Server & performance", "เซิร์ฟเวอร์และประสิทธิภาพ"),
    "ai": ("AI provider", "ผู้ให้บริการ AI"),
    "pipeline": ("Pipeline & rendering", "ไปป์ไลน์และการเรนเดอร์"),
    "logging": ("Logging", "การบันทึก log"),
}

DEFAULT_SETTINGS: dict[str, Any] = {
    "lang": "en",
    "source": DEFAULT_SOURCE,
    "host": "127.0.0.1",
    "port": 7860,
    "auto_check_update": True,
    "auto_start_server": False,
    "keep_api_key": True,
    "autoscroll": True,
    "log_wrap": False,
    "log_level_filter": "all",
    "ai_temperature": "",
    "ai_max_tokens": "",
    "env": {},              # curated fields  {ENV_NAME: value}
    "advanced_env": {},     # auto-discovered fields
    "prompt_overrides": {},  # {lang_code: prompt text}
}


def load_settings() -> dict[str, Any]:
    data = json.loads(json.dumps(DEFAULT_SETTINGS))  # deep copy
    if SETTINGS_FILE.is_file():
        try:
            stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                for key, value in stored.items():
                    if key in data and isinstance(data[key], dict) and isinstance(value, dict):
                        data[key].update(value)
                    else:
                        data[key] = value
        except (OSError, ValueError) as exc:
            print(f"settings: unreadable ({exc}); using defaults", flush=True)
    return data


def save_settings(settings: dict[str, Any]) -> None:
    ensure_dirs()
    payload = json.loads(json.dumps(settings))
    if not payload.get("keep_api_key", True):
        payload.get("env", {}).pop("AI_API_KEY", None)
    tmp = SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, SETTINGS_FILE)


def read_install_info() -> dict[str, Any]:
    if INSTALL_FILE.is_file():
        try:
            return json.loads(INSTALL_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def write_install_info(info: dict[str, Any]) -> None:
    ensure_dirs()
    INSTALL_FILE.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")


# Source location (GitHub URL or local folder) — user editable
@dataclass(frozen=True)
class Source:
    kind: str                # "github" | "local"
    raw: str
    owner: str = ""
    repo: str = ""
    branch: str = "main"
    subpath: str = "api"
    local: Path | None = None

    @property
    def label(self) -> str:
        if self.kind == "local":
            return f"local folder: {self.local}"
        return f"{self.owner}/{self.repo}@{self.branch}/{self.subpath}"

    @property
    def zip_url(self) -> str:
        return (
            f"https://codeload.github.com/{self.owner}/{self.repo}"
            f"/zip/refs/heads/{self.branch}"
        )

    @property
    def commits_api(self) -> str:
        path = urllib.parse.quote(self.subpath) if self.subpath else ""
        return (
            f"https://api.github.com/repos/{self.owner}/{self.repo}/commits"
            f"?sha={urllib.parse.quote(self.branch)}&per_page=1"
            + (f"&path={path}" if path else "")
        )

    @property
    def web_url(self) -> str:
        if self.kind == "local":
            return ""
        return (
            f"https://github.com/{self.owner}/{self.repo}/tree/"
            f"{self.branch}/{self.subpath}".rstrip("/")
        )


def parse_source(text: str) -> Source:
    """Turn what the user typed into a :class:`Source`.

    Accepted forms::

        https://github.com/OWNER/REPO/tree/BRANCH/api
        https://github.com/OWNER/REPO            (-> main/api)
        OWNER/REPO                               (-> main/api)
        D:\\some\\local\\api                      (a folder on this machine)
    """
    raw = (text or "").strip().strip('"')
    if not raw:
        raise ValueError("source is empty")

    if raw.lower().startswith("file:///"):
        raw = urllib.parse.unquote(raw[8:])
    candidate = Path(os.path.expandvars(os.path.expanduser(raw)))
    if candidate.is_dir():
        return Source(kind="local", raw=raw, local=candidate.resolve())

    url = raw
    if not url.lower().startswith(("http://", "https://")):
        if re.fullmatch(r"[\w.-]+/[\w.-]+(/.*)?", url):
            url = "https://github.com/" + url
        else:
            raise ValueError(f"not a GitHub URL or an existing folder: {raw}")

    parts = urllib.parse.urlparse(url)
    if "github.com" not in parts.netloc.lower():
        raise ValueError("only github.com URLs are supported")
    segments = [s for s in parts.path.split("/") if s]
    if len(segments) < 2:
        raise ValueError("URL must contain OWNER/REPO")
    owner, repo = segments[0], segments[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    branch, subpath = "main", "api"
    if len(segments) >= 3 and segments[2] in ("tree", "blob"):
        if len(segments) >= 4:
            branch = segments[3]
        subpath = "/".join(segments[4:]) or ""
    return Source(kind="github", raw=raw, owner=owner, repo=repo,
                  branch=branch, subpath=subpath)


# HTTP helpers (stdlib only — the launcher must work before the wheels load)
def http_get(url: str, timeout: int = HTTP_TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.read()


def http_get_direct(url: str, timeout: int = 5) -> bytes:
    """GET that never goes through a proxy — used for the local health probe.

    A corporate HTTPS_PROXY that does not exempt 127.0.0.1 would otherwise make
    the launcher believe its own server never came up.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with opener.open(req, timeout=timeout) as resp:
        return resp.read()


def http_download(url: str, dest: Path, log: LogBus,
                  progress: Callable[[int, int], None] | None = None,
                  timeout: int = 600) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        last = 0.0
        with open(tmp, "wb") as fh:
            while True:
                chunk = resp.read(1 << 18)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                now = time.time()
                if now - last > 0.7:
                    last = now
                    if progress:
                        progress(done, total)
                    else:
                        mb = done / 1048576
                        tail = f" / {total / 1048576:.1f} MB" if total else ""
                        log.emit(f"download: {mb:.1f} MB{tail}", "dbg")
    os.replace(tmp, dest)
    return dest


# Updater
class Updater:
    """Fetches the ``api/`` folder from GitHub into the private cache."""

    def __init__(self, bus: LogBus) -> None:
        self.bus = bus

    # -- state --------------------------------------------------------------
    @staticmethod
    def installed() -> bool:
        return (API_DIR / "backend" / "main.py").is_file()

    def remote_commit(self, src: Source) -> dict[str, str]:
        """Latest commit touching the source path.  Raises on failure."""
        if src.kind != "github":
            raise ValueError("local sources have no commit information")
        payload = json.loads(http_get(src.commits_api, timeout=30).decode("utf-8"))
        if not isinstance(payload, list) or not payload:
            raise ValueError("GitHub returned no commits for this path")
        head = payload[0]
        commit = head.get("commit") or {}
        return {
            "sha": str(head.get("sha") or "")[:40],
            "date": str((commit.get("committer") or {}).get("date") or ""),
            "message": str(commit.get("message") or "").splitlines()[0][:120],
        }

    def check(self, src: Source) -> dict[str, Any]:
        """Compare the installed commit with the remote one."""
        info = read_install_info()
        local_sha = str(info.get("sha") or "")
        if src.kind == "local":
            return {"update_available": False, "local_sha": "local", "remote": {},
                    "reason": "local folder is used directly"}
        remote = self.remote_commit(src)
        same_source = info.get("source_label") == src.label
        available = (not self.installed()) or (not same_source) or (
            bool(remote["sha"]) and remote["sha"] != local_sha)
        return {"update_available": available, "local_sha": local_sha,
                "remote": remote, "reason": "" if same_source else "source changed"}

    # -- install ------------------------------------------------------------
    def install(self, src: Source, progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
        ensure_dirs()
        if src.kind == "local":
            return self._install_from_dir(src, src.local or Path("."))

        self.bus.emit(f"update: downloading {src.zip_url}", "info")
        zip_path = TMP_DIR / f"{src.repo}-{src.branch.replace('/', '_')}.zip"
        try:
            http_download(src.zip_url, zip_path, self.bus, progress)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"HTTP {exc.code} from GitHub — check the branch name "
                f"('{src.branch}') and that the repository is public"
            ) from exc
        size_mb = zip_path.stat().st_size / 1048576
        self.bus.emit(f"update: archive downloaded ({size_mb:.1f} MB)", "ok")

        staging = TMP_DIR / "staging"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True, exist_ok=True)
        wanted = (src.subpath or "").strip("/")
        extracted = 0
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            if not names:
                raise RuntimeError("archive is empty")
            root = names[0].split("/", 1)[0] + "/"
            prefix = root + (wanted + "/" if wanted else "")
            for name in names:
                if name.endswith("/") or not name.startswith(prefix):
                    continue
                rel = name[len(prefix):]
                if not rel or ".." in rel.split("/"):
                    continue
                target = staging / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(name) as sfh, open(target, "wb") as dfh:
                    shutil.copyfileobj(sfh, dfh)
                extracted += 1
        if extracted == 0:
            raise RuntimeError(
                f"nothing found under '{wanted}' in {src.owner}/{src.repo}@{src.branch} "
                f"— is the path in the source URL correct?"
            )
        self.bus.emit(f"update: extracted {extracted} files from '{wanted or '/'}'", "info")
        result = self._swap_in(staging, src, extracted)
        try:
            zip_path.unlink()
        except OSError:
            pass
        return result

    def _install_from_dir(self, src: Source, folder: Path) -> dict[str, Any]:
        """A local folder is used in place — nothing is copied."""
        if not (folder / "backend" / "main.py").is_file():
            raise RuntimeError(f"{folder} does not look like the api folder "
                               f"(backend/main.py not found)")
        info = {"source_label": src.label, "source_raw": src.raw, "kind": "local",
                "path": str(folder), "sha": "local",
                "installed_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        write_install_info(info)
        self.bus.emit(f"update: using local folder {folder}", "ok")
        return info

    def _validate(self, folder: Path) -> None:
        required = ("backend/main.py", "backend/config.py")
        missing = [r for r in required if not (folder / r).is_file()]
        if missing:
            raise RuntimeError("downloaded source is not usable, missing: "
                               + ", ".join(missing))

    def _swap_in(self, staging: Path, src: Source, file_count: int) -> dict[str, Any]:
        self._validate(staging)
        self._warn_if_requirements_changed(staging)

        if API_DIR.exists():
            retired = TMP_DIR / f"api_old_{int(time.time())}"
            os.replace(API_DIR, retired)
            shutil.rmtree(retired, ignore_errors=True)
        API_DIR.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging, API_DIR)

        sha = date = message = ""
        try:
            remote = self.remote_commit(src)
            sha, date, message = remote["sha"], remote["date"], remote["message"]
        except Exception as exc:  # noqa: BLE001
            self.bus.emit(
                f"update: installed, but the commit id could not be read ({exc}); "
                f"'Check update' will re-download next time",
                "warn",
            )
        info = {"source_label": src.label, "source_raw": src.raw, "kind": "github",
                "sha": sha, "commit_date": date, "commit_message": message,
                "files": file_count,
                "installed_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        write_install_info(info)
        self.sync_assets()
        self.bus.emit(
            f"update: installed {file_count} files"
            + (f" @ {sha[:8]}" if sha else "") + " — restart the server to use it",
            "ok",
        )
        return info

    def _warn_if_requirements_changed(self, staging: Path) -> None:
        """A new pip dependency cannot be installed into a frozen exe."""
        new_file = staging / "requirements.txt"
        old_file = API_DIR / "requirements.txt"
        if not new_file.is_file() or not old_file.is_file():
            return

        def names(path: Path) -> set[str]:
            out = set()
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.split("#", 1)[0].strip()
                if line:
                    out.add(re.split(r"[<>=\[!~ ]", line, 1)[0].lower())
            return out

        added = names(new_file) - names(old_file)
        if added:
            self.bus.emit(
                "update: the API now also requires " + ", ".join(sorted(added))
                + " — a frozen .exe cannot pip-install; rebuild the exe "
                  "(or run from source) if the server errors out",
                "warn",
            )

    # -- assets that must survive an api update -----------------------------
    def sync_assets(self) -> None:
        """Copy fonts / ONNX model out of the api folder into ``runtime/``.

        ``runtime/`` is the server's working directory, so anything the API
        downloads on demand (Noto fonts, the detector weights) is kept there
        and is *not* wiped when the api folder is replaced.
        """
        ensure_dirs()
        moved = []
        for ttf in list(API_DIR.glob("*.ttf")) + list(API_DIR.glob("*.otf")):
            dest = RUNTIME_DIR / ttf.name
            if not dest.is_file() or dest.stat().st_size != ttf.stat().st_size:
                shutil.copy2(ttf, dest)
                moved.append(ttf.name)
        src_model = API_DIR / "models" / MODEL_NAME
        dest_model = RUNTIME_DIR / "models" / MODEL_NAME
        if src_model.is_file() and (
            not dest_model.is_file()
            or dest_model.stat().st_size != src_model.stat().st_size
        ):
            shutil.copy2(src_model, dest_model)
            moved.append(f"models/{MODEL_NAME}")
        if moved:
            self.bus.emit("assets: cached " + ", ".join(moved), "dbg")

    def download_model(self, url: str, progress: Callable[[int, int], None] | None = None) -> Path:
        dest = RUNTIME_DIR / "models" / MODEL_NAME
        self.bus.emit(f"model: downloading {url}", "info")
        http_download(url, dest, self.bus, progress)
        self.bus.emit(f"model: ready ({dest.stat().st_size / 1048576:.1f} MB)", "ok")
        return dest


# Environment-variable discovery — this is what keeps the UI future-proof.
@dataclass
class DiscoveredVar:
    name: str
    default: str
    kind: str
    where: str


_ENV_HELPER_RE = re.compile(
    r"_env_(int|float|str|bool)\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']\s*(?:,\s*([^)]*))?\)"
)
_ENV_GET_RE = re.compile(
    r"os\.environ\.get\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']\s*(?:,\s*[\"']([^\"']*)[\"'])?"
)


def discover_env_vars(api_dir: Path) -> list[DiscoveredVar]:
    """Scan the cached API source for every environment knob it reads."""
    found: dict[str, DiscoveredVar] = {}
    if not api_dir.is_dir():
        return []
    for path in sorted(api_dir.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = path.relative_to(api_dir).as_posix()
        for kind, name, default in _ENV_HELPER_RE.findall(text):
            default = (default or "").strip().strip("\"'")
            found.setdefault(name, DiscoveredVar(name, default, kind, rel))
        for name, default in _ENV_GET_RE.findall(text):
            found.setdefault(name, DiscoveredVar(name, default, "str", rel))
    return sorted(found.values(), key=lambda v: v.name)


# Settings schema — the curated page adapts to the API that is installed.
#
# Three layers, in priority order:
#   1. ``ui-settings.json`` shipped inside the api folder (repo-controlled),
#   2. the CURATED table compiled into this launcher,
#   3. the raw scan of the source, which fills in every default and shows
#      anything neither layer knows about on the Advanced page.
#
# A field whose environment variable has disappeared from the API is hidden
# instead of lingering as a control that silently does nothing.
UI_SCHEMA_FILES = ("ui-settings.json", "launcher-ui.json")
_KIND_FROM_SOURCE = {"int": "int", "float": "float", "bool": "bool", "str": "str"}


@dataclass
class SchemaResult:
    specs: list[FieldSpec]
    groups: dict[str, tuple[str, str]]
    origin: str                       # where the layout came from
    hidden: list[str]                 # curated keys the API no longer reads
    extra: list[str]                  # API options the curated page misses
    discovered: list[DiscoveredVar]
    notes: list[tuple[str, str]]      # (level, message) for the log

    @property
    def keys(self) -> set[str]:
        return {s.key for s in self.specs}


def load_ui_schema_file(api_dir: Path) -> tuple[list[FieldSpec], dict[str, tuple[str, str]], str]:
    """Read an optional UI layout shipped with the API.

    Lets the repository reorganise this launcher's Settings page — add a field,
    rename a label, regroup — without anybody rebuilding the .exe.  Raises
    ValueError with a precise reason when the file exists but is unusable;
    the caller reports that and keeps the built-in layout.
    """
    path = next((api_dir / name for name in UI_SCHEMA_FILES
                 if (api_dir / name).is_file()), None)
    if path is None:
        return [], {}, ""

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{path.name} could not be read: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} must contain a JSON object")

    groups: dict[str, tuple[str, str]] = {}
    for entry in data.get("groups") or []:
        if not isinstance(entry, dict) or not entry.get("id"):
            raise ValueError(f"{path.name}: every group needs an 'id'")
        gid = str(entry["id"])
        groups[gid] = (str(entry.get("en") or gid), str(entry.get("th") or entry.get("en") or gid))

    raw_fields = data.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields:
        raise ValueError(f"{path.name}: 'fields' must be a non-empty list")

    specs: list[FieldSpec] = []
    for i, entry in enumerate(raw_fields):
        if not isinstance(entry, dict):
            raise ValueError(f"{path.name}: field #{i} is not an object")
        key = str(entry.get("key") or "").strip()
        if not key:
            raise ValueError(f"{path.name}: field #{i} has no 'key'")
        group = str(entry.get("group") or "other")
        if group not in groups:
            groups[group] = (group.replace("_", " ").title(),
                             group.replace("_", " ").title())
        kind = str(entry.get("kind") or "str")
        if kind not in ("str", "int", "float", "bool", "choice", "secret"):
            raise ValueError(f"{path.name}: field '{key}' has unknown kind '{kind}'")
        specs.append(FieldSpec(
            key=key, group=group,
            en=str(entry.get("en") or key), th=str(entry.get("th") or entry.get("en") or key),
            kind=kind, default=str(entry.get("default") or ""),
            choices=tuple(str(c) for c in (entry.get("choices") or ())),
            hint_en=str(entry.get("hint_en") or ""),
            hint_th=str(entry.get("hint_th") or entry.get("hint_en") or ""),
        ))
    return specs, groups, path.name


def build_schema(api_dir: Path) -> SchemaResult:
    """Reconcile the settings layout with the API that is actually installed."""
    notes: list[tuple[str, str]] = []
    discovered = discover_env_vars(api_dir)

    specs = list(CURATED)
    groups = dict(GROUP_TITLES)
    origin = "built-in"
    try:
        file_specs, file_groups, filename = load_ui_schema_file(api_dir)
        if file_specs:
            specs, origin = file_specs, filename
            groups = {**GROUP_TITLES, **file_groups}
            notes.append(("ok", f"settings layout loaded from the API's {filename} "
                                f"({len(file_specs)} fields)"))
    except ValueError as exc:
        notes.append(("err", f"settings layout: {exc} — using the built-in layout"))

    if not discovered:
        notes.append(("warn", "settings: no API source to inspect yet, showing the "
                              "built-in layout unverified"))
        return SchemaResult(specs, groups, origin, [], [], [], notes)

    by_name = {v.name: v for v in discovered}
    live: list[FieldSpec] = []
    hidden: list[str] = []
    for spec in specs:
        found = by_name.get(spec.key)
        if found is None:
            hidden.append(spec.key)
            continue
        # The API source is the authority on the default and the value type,
        # so an outdated exe still shows the truth.
        kind = spec.kind if spec.kind in ("choice", "secret") else \
            _KIND_FROM_SOURCE.get(found.kind, spec.kind)
        live.append(replace(spec, default=found.default or spec.default, kind=kind))

    extra = sorted(set(by_name) - {s.key for s in live})
    if hidden:
        notes.append(("warn", "settings: hidden because this API version no longer "
                              "reads them — " + ", ".join(sorted(hidden))))
    if extra:
        notes.append(("info", f"settings: {len(extra)} further option(s) available "
                              f"on the Advanced page"))
    used_groups = {s.group for s in live}
    return SchemaResult(live, {k: v for k, v in groups.items() if k in used_groups},
                        origin, sorted(hidden), extra, discovered, notes)


# What an API update added / removed
SNAPSHOT_FILE = "env_snapshot.json"


def read_env_snapshot() -> dict[str, Any]:
    path = DATA_DIR / SNAPSHOT_FILE
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            pass
    return {}


def record_env_snapshot(discovered: Iterable[DiscoveredVar]) -> tuple[list[str], list[str]]:
    """Store the current option list and return ``(added, removed)``.

    Called right after an install, so the Advanced page can point at exactly
    what the update changed instead of leaving the user to spot it.
    """
    names = sorted({v.name for v in discovered})
    previous = read_env_snapshot().get("names")
    if not isinstance(previous, list) or not previous:
        previous = names  # first install: nothing is "new"
    added = sorted(set(names) - set(previous))
    removed = sorted(set(previous) - set(names))
    ensure_dirs()
    (DATA_DIR / SNAPSHOT_FILE).write_text(json.dumps(
        {"names": names, "previous": previous, "added": added, "removed": removed,
         "at": time.strftime("%Y-%m-%d %H:%M:%S")},
        ensure_ascii=False, indent=2), encoding="utf-8")
    return added, removed


# Server controller
STATE_STOPPED = "stopped"
STATE_STARTING = "starting"
STATE_RUNNING = "running"
STATE_STOPPING = "stopping"
STATE_ERROR = "error"


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1" if host in ("0.0.0.0", "") else host,
                                port)) == 0


def uvicorn_log_config(bus: LogBus) -> dict[str, Any]:
    """Route uvicorn's logging into the UI log instead of a console."""
    global _LOG_BUS_FOR_HANDLER
    _LOG_BUS_FOR_HANDLER = bus
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"plain": {"format": "%(levelname)s %(name)s: %(message)s"}},
        "handlers": {
            "bus": {
                "()": f"{__name__}.BusLogHandler",
                "formatter": "plain",
            }
        },
        "root": {"handlers": ["bus"], "level": "INFO"},
        "loggers": {
            "uvicorn": {"handlers": ["bus"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"handlers": ["bus"], "level": "INFO", "propagate": False},
            "uvicorn.access": {"handlers": ["bus"], "level": "INFO", "propagate": False},
        },
    }


_LOG_BUS_FOR_HANDLER: LogBus | None = None


class BusLogHandler(logging.Handler):
    """Standard-library log handler that writes into the UI log bus."""

    _LEVEL_MAP = {
        logging.DEBUG: "dbg",
        logging.INFO: "info",
        logging.WARNING: "warn",
        logging.ERROR: "err",
        logging.CRITICAL: "err",
    }

    def emit(self, record: logging.LogRecord) -> None:
        bus = _LOG_BUS_FOR_HANDLER
        if bus is None:
            return
        try:
            bus.emit(self.format(record), self._LEVEL_MAP.get(record.levelno, "info"))
        except Exception:  # noqa: BLE001 - logging must never raise
            pass


class ServerController:
    """Starts / stops uvicorn in a worker thread inside this process."""

    def __init__(self, bus: LogBus, on_state: Callable[[str, str], None]) -> None:
        self.bus = bus
        self.on_state = on_state
        self.state = STATE_STOPPED
        self.started_at = 0.0
        self.url = ""
        self._server: Any = None
        self._thread: threading.Thread | None = None
        self._applied_env: set[str] = set()
        self._stop_requested = False

    # -- helpers ------------------------------------------------------------
    def _set_state(self, state: str, detail: str = "") -> None:
        self.state = state
        self.on_state(state, detail)

    def is_busy(self) -> bool:
        return self.state in (STATE_STARTING, STATE_RUNNING, STATE_STOPPING)

    @staticmethod
    def _purge_api_modules() -> None:
        """Forget the previously imported API so an update takes effect."""
        for name in [n for n in list(sys.modules)
                     if n == "backend" or n.startswith("backend.")]:
            sys.modules.pop(name, None)
        importlib.invalidate_caches()

    # -- lifecycle ----------------------------------------------------------
    def start(self, settings: dict[str, Any], api_dir: Path) -> None:
        if self.is_busy():
            self.bus.emit("server: already running", "warn")
            return
        if not (api_dir / "backend" / "main.py").is_file():
            self.bus.emit(
                f"server: no API source in {api_dir} — press 'Update now' first", "err")
            self._set_state(STATE_ERROR, "no api source")
            return
        host = str(settings.get("host") or "127.0.0.1")
        port = int(settings.get("port") or 7860)
        if port_in_use(host, port):
            self.bus.emit(
                f"server: port {port} is already taken — close the other program "
                f"or change the port", "err")
            self._set_state(STATE_ERROR, f"port {port} busy")
            return
        self._stop_requested = False
        self._set_state(STATE_STARTING)
        self._thread = threading.Thread(
            target=self._run, args=(settings, api_dir, host, port),
            name="tp-server", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        thread = self._thread
        if thread is None or not thread.is_alive():
            self._set_state(STATE_STOPPED)
            return
        # Stop pressed during "Starting…": the uvicorn object may not exist
        # yet, so the flag is what makes the boot abort instead of leaving a
        # server running behind a "Stopped" badge.
        self._stop_requested = True
        self._set_state(STATE_STOPPING)
        self.bus.emit("server: stopping …", "info")
        if self._server is not None:
            try:
                self._server.should_exit = True
            except Exception as exc:  # noqa: BLE001
                self.bus.emit(f"server: stop request failed: {exc}", "err")

    def wait_stopped(self, timeout: float = 20.0) -> bool:
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    # -- worker thread ------------------------------------------------------
    def _run(self, settings: dict[str, Any], api_dir: Path, host: str, port: int) -> None:
        try:
            ensure_dirs()
            os.chdir(RUNTIME_DIR)  # fonts + model download here, and survive updates

            self._purge_api_modules()
            api_str = str(api_dir)
            while api_str in sys.path:
                sys.path.remove(api_str)
            sys.path.insert(0, api_str)

            env = build_env(settings)
            # A setting the user cleared must really disappear: os.environ is
            # process-wide, so anything set by the previous start and no longer
            # wanted is removed instead of quietly staying in effect.
            for stale in self._applied_env - set(env):
                os.environ.pop(stale, None)
                self.bus.emit(f"server: cleared {stale} (back to the API default)",
                              "dbg")
            for key, value in env.items():
                os.environ[key] = value
            self._applied_env = set(env)
            shown = ", ".join(
                f"{k}={'***' if ('KEY' in k or 'TOKEN' in k) else v}"
                for k, v in sorted(env.items()))
            self.bus.emit(f"server: env {shown or '(API defaults)'}", "dbg")

            apply_code_overrides(settings, self.bus)

            import uvicorn

            main_mod = importlib.import_module("backend.main")
            app = getattr(main_mod, "app", None)
            if app is None:
                raise RuntimeError("backend.main has no 'app' object")

            config = uvicorn.Config(
                app,
                host=host,
                port=port,
                loop="asyncio",
                log_config=uvicorn_log_config(self.bus),
                access_log=(str(env.get("TP_ACCESS_LOG_MODE", "summary")).lower()
                            == "uvicorn"),
                timeout_keep_alive=30,
            )
            self._server = uvicorn.Server(config)
            self.url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}"
            if self._stop_requested:
                self.bus.emit("server: start cancelled before it opened the port",
                              "warn")
                self._set_state(STATE_STOPPED)
                return
            self.started_at = time.time()
            self.bus.emit(f"server: starting on {self.url} (source: {api_dir})", "info")
            threading.Thread(target=self._health_watch, daemon=True).start()
            self._server.run()  # blocks until should_exit
            self.bus.emit("server: stopped", "info")
            self._set_state(STATE_STOPPED)
        except Exception as exc:  # noqa: BLE001 - surfaced in the UI
            self.bus.emit(f"server: crashed — {type(exc).__name__}: {exc}", "err")
            self.bus.emit(traceback.format_exc(), "err")
            self._set_state(STATE_ERROR, str(exc)[:120])
        finally:
            self._server = None
            self.started_at = 0.0

    def _health_watch(self) -> None:
        """Flip the badge to 'running' only once /health really answers."""
        deadline = time.time() + 90
        while time.time() < deadline:
            if self.state in (STATE_STOPPED, STATE_STOPPING, STATE_ERROR):
                return
            try:
                body = http_get_direct(f"{self.url}/health", timeout=3)
                payload = json.loads(body.decode("utf-8"))
                self.bus.emit(f"server: ready — build {payload.get('build')}", "ok")
                self._set_state(STATE_RUNNING, self.url)
                self._check_localhost_alias()
                return
            except Exception:  # noqa: BLE001 - not up yet
                time.sleep(0.6)
        self.bus.emit("server: /health did not answer within 90 s", "warn")

    def _check_localhost_alias(self) -> None:
        """Verify the hostname the browser extension will actually dial.

        The extension normalises ``127.0.0.1`` / ``0.0.0.0`` to ``localhost``
        before calling the API.  On some machines ``localhost`` resolves to the
        IPv6 address ``::1`` first, which a server bound to IPv4 never answers.
        Better to say so here than to let the user debug a silent failure in
        the browser.
        """
        port = self.url.rsplit(":", 1)[-1]
        try:
            http_get_direct(f"http://localhost:{port}/health", timeout=4)
            self.bus.emit(f"server: reachable as http://localhost:{port} too "
                          f"(this is what the extension calls)", "ok")
        except Exception as exc:  # noqa: BLE001
            self.bus.emit(
                f"server: WARNING — http://localhost:{port} does not answer "
                f"({type(exc).__name__}). The extension rewrites 127.0.0.1 to "
                f"localhost, so it may fail to connect. Try Host = 0.0.0.0, or "
                f"type the address with 'localhost' in the extension.", "warn")


def build_env(settings: dict[str, Any]) -> dict[str, str]:
    """Curated + advanced settings turned into environment variables."""
    env: dict[str, str] = {}
    for spec in CURATED:
        raw = settings.get("env", {}).get(spec.key, "")
        value = str(raw).strip()
        if value == "" or value.lower() == "auto":
            continue
        env[spec.key] = value
    for key, raw in (settings.get("advanced_env") or {}).items():
        value = str(raw).strip()
        if value:
            env[str(key)] = value
    # Absolute paths so the model/fonts are shared across api updates.
    env.setdefault("TP_TEXTBLOCK_MODEL", str(RUNTIME_DIR / "models" / MODEL_NAME))
    return env


def apply_code_overrides(settings: dict[str, Any], bus: LogBus) -> None:
    """Apply settings the API exposes as module constants, not env vars.

    Done by importing the module and assigning the attribute *before*
    ``backend.main`` is imported.  Every failure is reported: if a future API
    version moves these names, the log says so instead of silently ignoring
    the user's setting.
    """
    temperature = str(settings.get("ai_temperature", "")).strip()
    max_tokens = str(settings.get("ai_max_tokens", "")).strip()
    prompts = {k: v for k, v in (settings.get("prompt_overrides") or {}).items()
               if str(v).strip()}
    if not (temperature or max_tokens or prompts):
        return

    if temperature or max_tokens:
        try:
            ai_config = importlib.import_module("backend.ai.config")
            if temperature:
                ai_config.TEMPERATURE = float(temperature)
                bus.emit(f"override: TEMPERATURE = {temperature}", "info")
            if max_tokens:
                ai_config.MAX_TOKENS = int(float(max_tokens))
                bus.emit(f"override: MAX_TOKENS = {max_tokens}", "info")
        except Exception as exc:  # noqa: BLE001
            bus.emit(f"override: temperature/max-tokens NOT applied ({exc})", "err")

    if prompts:
        try:
            prompts_mod = importlib.import_module("backend.ai.prompts")
            table = getattr(prompts_mod, "LANG_STYLE", None)
            if not isinstance(table, dict):
                raise AttributeError("backend.ai.prompts.LANG_STYLE is missing")
            for lang, text in prompts.items():
                table[lang] = str(text)
            bus.emit("override: default prompt replaced for "
                     + ", ".join(sorted(prompts)), "info")
        except Exception as exc:  # noqa: BLE001
            bus.emit(f"override: prompt NOT applied ({exc})", "err")


def read_default_prompt(api_dir: Path, lang: str) -> str:
    """Read the API's built-in style prompt for ``lang`` from the cache.

    Imported in a throw-away module namespace so it works whether or not the
    server is running.
    """
    prompts_file = api_dir / "backend" / "ai" / "prompts.py"
    if not prompts_file.is_file():
        raise FileNotFoundError(f"{prompts_file} not found — fetch the API first")
    text = prompts_file.read_text(encoding="utf-8", errors="replace")
    # Parse literals only — no import/execution — so this works whether or not
    # the server is running. Thai's production default is intentionally kept
    # in THAI_STYLE_COMPACT rather than duplicated inside LANG_STYLE.
    table: dict[str, str] | None = None
    thai_default: str | None = None
    for node in ast.parse(text).body:
        names: list[str] = []
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        value = getattr(node, "value", None)
        if value is None:
            continue
        if "LANG_STYLE" in names:
            table = ast.literal_eval(value)
        if "THAI_STYLE_COMPACT" in names:
            thai_default = str(ast.literal_eval(value)).strip()
    if not isinstance(table, dict):
        raise ValueError("LANG_STYLE not found in prompts.py")
    if lang == "th" and thai_default:
        return thai_default
    if lang in table:
        return str(table[lang]).strip()
    if "default" in table:
        return str(table["default"]).strip()
    raise KeyError(f"no prompt for '{lang}' and no 'default' entry")


# Translations
STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "app.title": APP_NAME,
        "app.subtitle": "Private, local OCR translation server",
        "nav.dashboard": "Dashboard",
        "nav.settings": "Settings",
        "nav.prompt": "AI prompt",
        "nav.advanced": "Advanced",
        "nav.source": "Source & update",
        "nav.about": "About",
        "btn.start": "▶  Start",
        "btn.stop": "■  Stop",
        "btn.restart": "⟳  Restart",
        "btn.open_docs": "Open API docs",
        "btn.copy_url": "Copy URL",
        "btn.check": "Check update",
        "btn.update": "Update now",
        "btn.apply": "Save settings",
        "btn.reset": "Reset to API defaults",
        "btn.clear": "Clear",
        "btn.copy": "Copy",
        "btn.save_log": "Save log…",
        "btn.browse": "Browse folder…",
        "btn.reset_source": "Reset to default",
        "btn.open_folder": "Open cache folder",
        "btn.download_model": "Download detector model",
        "btn.load_default": "Load API default",
        "btn.clear_override": "Remove override",
        "btn.cleanup": "Clean up unused values",
        "state.stopped": "Stopped",
        "state.starting": "Starting…",
        "state.running": "Running",
        "state.stopping": "Stopping…",
        "state.error": "Error",
        "card.server": "Server",
        "card.api": "API source",
        "card.log": "Live log",
        "lbl.address": "Address",
        "lbl.uptime": "Uptime",
        "lbl.autoscroll": "Auto-scroll",
        "lbl.wrap": "Wrap lines",
        "lbl.filter": "Level",
        "lbl.host": "Host",
        "lbl.port": "Port",
        "lbl.autostart": "Start the server when this app opens",
        "lbl.autocheck": "Check for API updates when this app opens",
        "lbl.keepkey": "Remember the AI API key on this computer",
        "lbl.source_url": "API source (GitHub URL or a local folder)",
        "lbl.installed": "Installed",
        "lbl.commit": "Commit",
        "lbl.files": "Files",
        "lbl.never": "not installed yet",
        "lbl.temperature": "Temperature (blank = API default 0.7)",
        "lbl.max_tokens": "Max output tokens (blank = API default 8192)",
        "lbl.prompt_lang": "Language",
        "lbl.language": "Language",
        "hint.restart": "Settings are applied the next time the server starts.",
        "hint.prompt": ("This replaces the API's built-in style prompt for the chosen "
                        "language. It is used when the browser extension does not send "
                        "a prompt of its own."),
        "hint.advanced": ("Every environment option found in the downloaded API source. "
                          "Blank = keep the API's own default. Options an update added "
                          "are marked NEW and listed first; ones it removed are named "
                          "above. No new .exe is ever needed for this."),
        "hint.source": ("Point this at any fork or branch. A folder path on this "
                        "computer is used directly, which is handy while developing."),
        "hint.extension": "Set this address as the API endpoint in the browser extension.",
        "hint.cache": "Settings and the API cache live in:",
        "msg.stop_first": "Stop the server before updating the API source.",
        "msg.saved": "Settings saved.",
        "msg.no_update": "Already up to date.",
        "msg.update_found": "An update is available.",
        "msg.confirm_quit": "The server is running. Stop it and quit?",
        "about.body": (
            "This launcher runs the TextPhantom OCR API on your own machine so your "
            "pages are never queued behind other users of the public Space.\n\n"
            "The .exe holds only the Python runtime and the libraries. The API code "
            "itself is downloaded from the source URL and cached privately, so a new "
            "API version needs no new .exe."),
    },
    "th": {
        "app.title": APP_NAME,
        "app.subtitle": "เซิร์ฟเวอร์แปลภาพส่วนตัวบนเครื่องคุณ",
        "nav.dashboard": "หน้าหลัก",
        "nav.settings": "ตั้งค่า",
        "nav.prompt": "พรอมต์ AI",
        "nav.advanced": "ขั้นสูง",
        "nav.source": "ต้นทาง & อัปเดต",
        "nav.about": "เกี่ยวกับ",
        "btn.start": "▶  เริ่ม",
        "btn.stop": "■  หยุด",
        "btn.restart": "⟳  เริ่มใหม่",
        "btn.open_docs": "เปิดหน้าเอกสาร API",
        "btn.copy_url": "คัดลอก URL",
        "btn.check": "ตรวจอัปเดต",
        "btn.update": "อัปเดตเลย",
        "btn.apply": "บันทึกการตั้งค่า",
        "btn.reset": "คืนค่าเริ่มต้นของ API",
        "btn.clear": "ล้าง",
        "btn.copy": "คัดลอก",
        "btn.save_log": "บันทึก log…",
        "btn.browse": "เลือกโฟลเดอร์…",
        "btn.reset_source": "คืนค่าเริ่มต้น",
        "btn.open_folder": "เปิดโฟลเดอร์แคช",
        "btn.download_model": "ดาวน์โหลดโมเดลตรวจกรอบ",
        "btn.load_default": "ดึงพรอมต์เริ่มต้นของ API",
        "btn.clear_override": "ยกเลิกการแทนที่",
        "btn.cleanup": "ล้างค่าที่ไม่ได้ใช้แล้ว",
        "state.stopped": "หยุดอยู่",
        "state.starting": "กำลังเริ่ม…",
        "state.running": "ทำงานอยู่",
        "state.stopping": "กำลังหยุด…",
        "state.error": "ผิดพลาด",
        "card.server": "เซิร์ฟเวอร์",
        "card.api": "ต้นทาง API",
        "card.log": "log สด",
        "lbl.address": "ที่อยู่",
        "lbl.uptime": "เวลาทำงาน",
        "lbl.autoscroll": "เลื่อนอัตโนมัติ",
        "lbl.wrap": "ตัดบรรทัด",
        "lbl.filter": "ระดับ",
        "lbl.host": "โฮสต์",
        "lbl.port": "พอร์ต",
        "lbl.autostart": "เริ่มเซิร์ฟเวอร์ทันทีเมื่อเปิดโปรแกรม",
        "lbl.autocheck": "ตรวจอัปเดต API เมื่อเปิดโปรแกรม",
        "lbl.keepkey": "จำคีย์ AI ไว้ในเครื่องนี้",
        "lbl.source_url": "ต้นทาง API (ลิงก์ GitHub หรือโฟลเดอร์ในเครื่อง)",
        "lbl.installed": "ติดตั้งเมื่อ",
        "lbl.commit": "คอมมิต",
        "lbl.files": "จำนวนไฟล์",
        "lbl.never": "ยังไม่ได้ติดตั้ง",
        "lbl.temperature": "Temperature (เว้นว่าง = ค่าเริ่มต้น 0.7)",
        "lbl.max_tokens": "โทเคนผลลัพธ์สูงสุด (เว้นว่าง = ค่าเริ่มต้น 8192)",
        "lbl.prompt_lang": "ภาษา",
        "lbl.language": "ภาษา",
        "hint.restart": "การตั้งค่าจะมีผลเมื่อเริ่มเซิร์ฟเวอร์ครั้งถัดไป",
        "hint.prompt": ("ใช้แทนพรอมต์สไตล์ที่มาพร้อม API ของภาษาที่เลือก "
                        "จะถูกใช้เมื่อส่วนขยายในเบราว์เซอร์ไม่ได้ส่งพรอมต์ของตัวเองมา"),
        "hint.advanced": ("รวมทุกตัวเลือก environment ที่พบในซอร์ส API ที่ดาวน์โหลดมา "
                          "เว้นว่าง = ใช้ค่าเริ่มต้นของ API เอง ตัวที่อัปเดตเพิ่มเข้ามาจะติดป้าย "
                          "NEW และเรียงขึ้นก่อน ส่วนตัวที่ถูกเอาออกจะแจ้งไว้ด้านบน "
                          "ทั้งหมดนี้ไม่ต้องสร้าง .exe ใหม่"),
        "hint.source": ("ตั้งเป็น fork หรือ branch ไหนก็ได้ ถ้าใส่เป็นพาธโฟลเดอร์ในเครื่อง "
                        "จะใช้โฟลเดอร์นั้นตรงๆ เหมาะกับเวลาแก้โค้ดเอง"),
        "hint.extension": "นำที่อยู่นี้ไปตั้งเป็น API endpoint ในส่วนขยายเบราว์เซอร์",
        "hint.cache": "การตั้งค่าและแคช API เก็บไว้ที่:",
        "msg.stop_first": "กรุณาหยุดเซิร์ฟเวอร์ก่อนอัปเดตซอร์ส API",
        "msg.saved": "บันทึกการตั้งค่าแล้ว",
        "msg.no_update": "เป็นเวอร์ชันล่าสุดแล้ว",
        "msg.update_found": "มีอัปเดตใหม่",
        "msg.confirm_quit": "เซิร์ฟเวอร์กำลังทำงาน ต้องการหยุดและปิดโปรแกรมหรือไม่?",
        "about.body": (
            "โปรแกรมนี้รัน TextPhantom OCR API บนเครื่องของคุณเอง หน้าที่คุณแปลจึงไม่ต้อง"
            "ไปต่อคิวกับผู้ใช้คนอื่นบน Space สาธารณะ\n\n"
            "ตัว .exe บรรจุแค่ Python runtime กับไลบรารี ส่วนโค้ด API จะดาวน์โหลดจาก URL "
            "ต้นทางแล้วเก็บเป็นแคชส่วนตัว ดังนั้นเวอร์ชัน API ใหม่ไม่ต้องสร้าง .exe ใหม่"),
    },
}


# Theme
class C:
    BG = "#0e1014"
    PANEL = "#161922"
    PANEL2 = "#1c2029"
    BORDER = "#262b36"
    FG = "#e7e9f0"
    MUTED = "#8b93a7"
    ACCENT = "#5b8cff"
    ACCENT2 = "#7aa2ff"
    OK = "#3ddc97"
    WARN = "#ffb454"
    ERR = "#ff6b6b"
    DBG = "#7a8296"


STATE_COLORS = {
    STATE_STOPPED: C.MUTED,
    STATE_STARTING: C.WARN,
    STATE_RUNNING: C.OK,
    STATE_STOPPING: C.WARN,
    STATE_ERROR: C.ERR,
}

UI_FONT = "Segoe UI" if os.name == "nt" else "DejaVu Sans"
MONO_FONT = "Consolas" if os.name == "nt" else "DejaVu Sans Mono"

# Families tried in order.  The UI must render Thai and English side by side,
# so the first choice is a family that covers both.
UI_FONT_CANDIDATES = ("Segoe UI", "Leelawadee UI", "Tahoma", "Noto Sans Thai",
                      "DejaVu Sans", "TkDefaultFont")
MONO_FONT_CANDIDATES = ("Consolas", "Cascadia Mono", "DejaVu Sans Mono",
                        "Courier New", "TkFixedFont")


def resolve_fonts(log: LogBus) -> None:
    """Pick installed font families before any widget is created."""
    global UI_FONT, MONO_FONT
    try:
        from tkinter import font as tkfont

        available = {name.lower() for name in tkfont.families()}
    except Exception as exc:  # noqa: BLE001 - cosmetic only, but say so
        log.emit(f"fonts: family list unavailable ({exc}); using {UI_FONT}", "warn")
        return
    for slot, candidates in (("ui", UI_FONT_CANDIDATES), ("mono", MONO_FONT_CANDIDATES)):
        chosen = next((c for c in candidates if c.lower() in available), None)
        if chosen is None:
            log.emit(f"fonts: none of {candidates} are installed; "
                     f"keeping {UI_FONT if slot == 'ui' else MONO_FONT}", "warn")
            continue
        if slot == "ui":
            UI_FONT = chosen
        else:
            MONO_FONT = chosen
    log.emit(f"fonts: ui={UI_FONT} mono={MONO_FONT}", "dbg")


# Small widget helpers
class FlatButton(tk.Button):
    """tk.Button with full colour control + hover, in three variants."""

    def __init__(self, master: tk.Misc, variant: str = "ghost", **kw: Any) -> None:
        palette = {
            "accent": (C.ACCENT, C.ACCENT2, "#ffffff"),
            "ghost": (C.PANEL2, C.BORDER, C.FG),
            "danger": ("#3a2027", "#4d2630", "#ff8f8f"),
        }[variant]
        self._bg, self._hover, fg = palette
        options: dict[str, Any] = {
            "bd": 0, "relief": "flat", "cursor": "hand2",
            "bg": self._bg, "fg": fg,
            "activebackground": self._hover, "activeforeground": fg,
            "highlightthickness": 0, "padx": 14, "pady": 7,
            "font": (UI_FONT, 10, "bold" if variant == "accent" else "normal"),
            "disabledforeground": C.MUTED,
        }
        options.update(kw)  # caller wins — no duplicate-keyword crash
        super().__init__(master, **options)
        self.bind("<Enter>", self._enter)
        self.bind("<Leave>", self._leave)

    def _enter(self, _event: tk.Event) -> None:
        if str(self["state"]) != "disabled":
            self.config(bg=self._hover)

    def _leave(self, _event: tk.Event) -> None:
        self.config(bg=self._bg)


def card(master: tk.Misc, **kw: Any) -> tk.Frame:
    frame = tk.Frame(master, bg=C.PANEL, highlightbackground=C.BORDER,
                     highlightthickness=1, bd=0, **kw)
    return frame


class ScrollArea(tk.Frame):
    """Vertically scrollable container (Canvas + inner frame)."""

    def __init__(self, master: tk.Misc) -> None:
        super().__init__(master, bg=C.BG)
        self.canvas = tk.Canvas(self, bg=C.BG, highlightthickness=0, bd=0)
        self.bar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview,
                                 style="TP.Vertical.TScrollbar")
        self.inner = tk.Frame(self.canvas, bg=C.BG)
        self._window = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.bar.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.bar.pack(side="right", fill="y")
        self.inner.bind("<Configure>", self._on_inner)
        self.canvas.bind("<Configure>", self._on_canvas)
        for widget in (self.canvas, self.inner):
            widget.bind("<Enter>", self._bind_wheel)
            widget.bind("<Leave>", self._unbind_wheel)

    def _on_inner(self, _event: tk.Event) -> None:
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas(self, event: tk.Event) -> None:
        self.canvas.itemconfigure(self._window, width=event.width)

    def _bind_wheel(self, _event: tk.Event) -> None:
        self.canvas.bind_all("<MouseWheel>", self._wheel)
        self.canvas.bind_all("<Button-4>", self._wheel)
        self.canvas.bind_all("<Button-5>", self._wheel)

    def _unbind_wheel(self, _event: tk.Event) -> None:
        for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.canvas.unbind_all(seq)

    def _wheel(self, event: tk.Event) -> None:
        delta = 0
        if getattr(event, "num", None) == 4:
            delta = 1
        elif getattr(event, "num", None) == 5:
            delta = -1
        elif getattr(event, "delta", 0):
            delta = 1 if event.delta > 0 else -1
        self.canvas.yview_scroll(-delta * 3, "units")


# The application window
class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        ensure_dirs()
        self.settings = load_settings()
        self.lang = str(self.settings.get("lang") or "en")
        self.bus = LogBus()
        self.updater = Updater(self.bus)
        self.controller = ServerController(self.bus, self._on_server_state)

        self._i18n: list[tuple[tk.Misc, str, str]] = []
        self.vars: dict[str, tk.Variable] = {}
        self.adv_vars: dict[str, tk.StringVar] = {}
        self._pages: dict[str, tk.Frame] = {}
        self._nav_buttons: dict[str, FlatButton] = {}
        self._nav_badges: dict[str, str] = {}
        self._current_page = "dashboard"
        self._log_lines = 0
        self.schema = build_schema(self._effective_api_dir())

        sys.stdout = StreamToBus(self.bus, sys.__stdout__)
        sys.stderr = StreamToBus(self.bus, sys.__stderr__)

        self._setup_window()
        resolve_fonts(self.bus)  # must happen before any widget is created
        self._setup_style()
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self.bus.emit(f"{APP_NAME} {LAUNCHER_VERSION} — {platform.platform()}", "info")
        self.bus.emit(f"data folder: {DATA_DIR}", "info")
        cleanup_tmp(self.bus)
        for level, message in self.schema.notes:
            self.bus.emit(message, level)
        threading.Thread(target=preload_runtime_deps, args=(self.bus,),
                         daemon=True).start()
        self.after(150, self._tick)
        self.after(600, self._first_run)

    # -- window / theme -----------------------------------------------------
    def _setup_window(self) -> None:
        self.title(APP_NAME)
        self.configure(bg=C.BG)
        self.minsize(1000, 660)
        width, height = 1180, 760
        x = max(0, (self.winfo_screenwidth() - width) // 2)
        y = max(0, (self.winfo_screenheight() - height) // 3)
        self.geometry(f"{width}x{height}+{x}+{y}")
        if os.name == "nt":
            try:
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except Exception as exc:  # noqa: BLE001 - cosmetic only
                self.bus.emit(f"dpi awareness not set ({exc}); text may look soft",
                              "dbg")
            self._use_dark_title_bar()

    def _use_dark_title_bar(self) -> None:
        """Match the Windows title bar to the dark UI (Windows 10 2004+)."""
        try:
            self.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
            value = ctypes.c_int(1)
            for attribute in (20, 19):  # 20 = current, 19 = older builds
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                        hwnd, attribute, ctypes.byref(value),
                        ctypes.sizeof(value)) == 0:
                    return
        except Exception as exc:  # noqa: BLE001 - purely cosmetic
            self.bus.emit(f"dark title bar unavailable ({exc})", "dbg")

    def _setup_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TP.TFrame", background=C.BG)
        style.configure("TP.TLabel", background=C.PANEL, foreground=C.FG,
                        font=(UI_FONT, 10))
        style.configure("TP.TEntry", fieldbackground=C.PANEL2, background=C.PANEL2,
                        foreground=C.FG, bordercolor=C.BORDER, lightcolor=C.BORDER,
                        darkcolor=C.BORDER, insertcolor=C.FG, padding=6)
        style.map("TP.TEntry", bordercolor=[("focus", C.ACCENT)])
        style.configure("TP.TCombobox", fieldbackground=C.PANEL2, background=C.PANEL2,
                        foreground=C.FG, arrowcolor=C.FG, bordercolor=C.BORDER,
                        lightcolor=C.BORDER, darkcolor=C.BORDER,
                        selectbackground=C.PANEL2, selectforeground=C.FG, padding=5)
        # A readonly combobox draws in its own state, so every colour needs an
        # explicit map or it reverts to the light default.
        style.map(
            "TP.TCombobox",
            fieldbackground=[("readonly", C.PANEL2), ("disabled", C.PANEL)],
            background=[("readonly", C.PANEL2), ("active", C.PANEL2)],
            foreground=[("readonly", C.FG), ("disabled", C.MUTED)],
            selectbackground=[("readonly", C.PANEL2)],
            selectforeground=[("readonly", C.FG)],
            arrowcolor=[("readonly", C.FG), ("active", C.ACCENT)],
            bordercolor=[("focus", C.ACCENT)],
        )
        self.option_add("*TCombobox*Listbox.background", C.PANEL2)
        self.option_add("*TCombobox*Listbox.foreground", C.FG)
        self.option_add("*TCombobox*Listbox.selectBackground", C.ACCENT)
        self.option_add("*TCombobox*Listbox.selectForeground", "#ffffff")
        # A scrollbar style name MUST carry the orientation, otherwise ttk
        # silently falls back to the default (white) look — which is exactly
        # what a "TP.Vertical.*" style on a horizontal bar produced.
        for orient in ("Vertical", "Horizontal"):
            style.configure(f"TP.{orient}.TScrollbar", background=C.BORDER,
                            troughcolor=C.PANEL2, bordercolor=C.PANEL2,
                            arrowcolor=C.MUTED, darkcolor=C.BORDER,
                            lightcolor=C.BORDER, gripcount=0,
                            relief="flat", arrowsize=12)
            style.map(f"TP.{orient}.TScrollbar",
                      background=[("active", C.MUTED), ("pressed", C.ACCENT)],
                      arrowcolor=[("active", C.FG)])
        style.configure("TP.TCheckbutton", background=C.PANEL, foreground=C.FG,
                        focuscolor=C.PANEL, font=(UI_FONT, 10),
                        indicatorbackground=C.PANEL2,
                        indicatorforeground=C.ACCENT, indicatorrelief="flat",
                        indicatormargin=4, padding=2)
        style.map("TP.TCheckbutton",
                  background=[("active", C.PANEL)],
                  indicatorbackground=[("selected", C.ACCENT),
                                       ("active", C.BORDER),
                                       ("!selected", C.PANEL2)],
                  indicatorforeground=[("selected", "#ffffff")])
        style.configure("TP.TSeparator", background=C.BORDER)

    # -- i18n ---------------------------------------------------------------
    def t(self, key: str) -> str:
        table = STRINGS.get(self.lang) or STRINGS["en"]
        return table.get(key) or STRINGS["en"].get(key) or key

    def reg(self, widget: tk.Misc, key: str, attr: str = "text") -> tk.Misc:
        self._i18n.append((widget, key, attr))
        try:
            widget.configure(**{attr: self.t(key)})
        except tk.TclError:
            pass
        return widget

    def _retranslate(self) -> None:
        for widget, key, attr in list(self._i18n):
            try:
                widget.configure(**{attr: self.t(key)})
            except tk.TclError:
                self._i18n.remove((widget, key, attr))
        self._refresh_status()
        self._refresh_api_card()
        self._apply_nav_badges()

    def _set_lang(self, lang: str) -> None:
        if lang == self.lang:
            return
        self.lang = lang
        self.settings["lang"] = lang
        save_settings(self.settings)
        self.lang_btn_en.config(bg=C.ACCENT if lang == "en" else C.PANEL2,
                                fg="#ffffff" if lang == "en" else C.MUTED)
        self.lang_btn_th.config(bg=C.ACCENT if lang == "th" else C.PANEL2,
                                fg="#ffffff" if lang == "th" else C.MUTED)
        self.lang_btn_en._bg = C.ACCENT if lang == "en" else C.PANEL2
        self.lang_btn_th._bg = C.ACCENT if lang == "th" else C.PANEL2
        self._retranslate()
        self._rebuild_settings_labels()

    # -- layout -------------------------------------------------------------
    def _build(self) -> None:
        self._build_header()
        body = tk.Frame(self, bg=C.BG)
        body.pack(fill="both", expand=True, padx=16, pady=(0, 14))
        self._build_sidebar(body)
        self.page_host = tk.Frame(body, bg=C.BG)
        self.page_host.pack(side="left", fill="both", expand=True, padx=(14, 0))
        for name, builder in (
            ("dashboard", self._page_dashboard),
            ("settings", self._page_settings),
            ("prompt", self._page_prompt),
            ("advanced", self._page_advanced),
            ("source", self._page_source),
            ("about", self._page_about),
        ):
            frame = tk.Frame(self.page_host, bg=C.BG)
            self._pages[name] = frame
            builder(frame)
        self._show_page("dashboard")

    def _build_header(self) -> None:
        head = tk.Frame(self, bg=C.BG)
        head.pack(fill="x", padx=16, pady=(14, 12))

        left = tk.Frame(head, bg=C.BG)
        left.pack(side="left")
        tk.Label(left, text="👻", bg=C.BG, fg=C.ACCENT,
                 font=(UI_FONT, 20)).pack(side="left", padx=(0, 10))
        titles = tk.Frame(left, bg=C.BG)
        titles.pack(side="left")
        tk.Label(titles, text=APP_NAME, bg=C.BG, fg=C.FG,
                 font=(UI_FONT, 15, "bold")).pack(anchor="w")
        self.reg(tk.Label(titles, bg=C.BG, fg=C.MUTED, font=(UI_FONT, 9)),
                 "app.subtitle").pack(anchor="w")

        right = tk.Frame(head, bg=C.BG)
        right.pack(side="right")
        self.lang_btn_th = FlatButton(right, "ghost", text="ไทย", padx=10, pady=5,
                                      command=lambda: self._set_lang("th"))
        self.lang_btn_en = FlatButton(right, "ghost", text="EN", padx=10, pady=5,
                                      command=lambda: self._set_lang("en"))
        self.lang_btn_en.pack(side="right", padx=(4, 0))
        self.lang_btn_th.pack(side="right")
        for btn, code in ((self.lang_btn_en, "en"), (self.lang_btn_th, "th")):
            active = self.lang == code
            btn._bg = C.ACCENT if active else C.PANEL2
            btn.config(bg=btn._bg, fg="#ffffff" if active else C.MUTED)

        self.status_wrap = tk.Frame(right, bg=C.PANEL2, highlightthickness=1,
                                    highlightbackground=C.BORDER)
        self.status_wrap.pack(side="right", padx=(0, 12))
        self.status_dot = tk.Label(self.status_wrap, text="●", bg=C.PANEL2,
                                   fg=C.MUTED, font=(UI_FONT, 11))
        self.status_dot.pack(side="left", padx=(10, 6), pady=5)
        self.status_text = tk.Label(self.status_wrap, text="", bg=C.PANEL2,
                                    fg=C.FG, font=(UI_FONT, 10, "bold"))
        self.status_text.pack(side="left", padx=(0, 12), pady=5)

    def _build_sidebar(self, parent: tk.Frame) -> None:
        side = tk.Frame(parent, bg=C.BG, width=196)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)
        for name, key in (
            ("dashboard", "nav.dashboard"),
            ("settings", "nav.settings"),
            ("prompt", "nav.prompt"),
            ("advanced", "nav.advanced"),
            ("source", "nav.source"),
            ("about", "nav.about"),
        ):
            btn = FlatButton(side, "ghost", anchor="w", padx=16, pady=10,
                             command=lambda n=name: self._show_page(n))
            self.reg(btn, key)
            btn.pack(fill="x", pady=(0, 6))
            self._nav_buttons[name] = btn

        spacer = tk.Frame(side, bg=C.BG)
        spacer.pack(fill="both", expand=True)
        tk.Label(side, text=f"v{LAUNCHER_VERSION}", bg=C.BG, fg=C.MUTED,
                 font=(UI_FONT, 8)).pack(anchor="w", pady=(0, 4))

    def _show_page(self, name: str) -> None:
        for page in self._pages.values():
            page.pack_forget()
        self._pages[name].pack(fill="both", expand=True)
        self._current_page = name
        for key, btn in self._nav_buttons.items():
            active = key == name
            btn._bg = C.PANEL if active else C.PANEL2
            btn._hover = C.PANEL if active else C.BORDER
            btn.config(bg=btn._bg, fg=C.ACCENT if active else C.FG,
                       font=(UI_FONT, 10, "bold" if active else "normal"))

    # -- dashboard ----------------------------------------------------------
    def _page_dashboard(self, parent: tk.Frame) -> None:
        top = tk.Frame(parent, bg=C.BG)
        top.pack(fill="x")

        server = card(top)
        server.pack(side="left", fill="both", expand=True)
        inner = tk.Frame(server, bg=C.PANEL)
        inner.pack(fill="both", expand=True, padx=16, pady=14)
        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9, "bold")),
                 "card.server").pack(anchor="w")

        row = tk.Frame(inner, bg=C.PANEL)
        row.pack(fill="x", pady=(10, 6))
        self.btn_start = FlatButton(row, "accent", command=self._on_start)
        self.reg(self.btn_start, "btn.start")
        self.btn_start.pack(side="left")
        self.btn_stop = FlatButton(row, "danger", command=self._on_stop)
        self.reg(self.btn_stop, "btn.stop")
        self.btn_stop.pack(side="left", padx=6)
        self.btn_restart = FlatButton(row, "ghost", command=self._on_restart)
        self.reg(self.btn_restart, "btn.restart")
        self.btn_restart.pack(side="left")

        addr = tk.Frame(inner, bg=C.PANEL)
        addr.pack(fill="x", pady=(8, 0))
        self.reg(tk.Label(addr, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9)),
                 "lbl.address").pack(side="left")
        self.lbl_url = tk.Label(addr, text="—", bg=C.PANEL, fg=C.ACCENT2,
                                font=(MONO_FONT, 10, "bold"))
        self.lbl_url.pack(side="left", padx=8)
        btn_copy = FlatButton(addr, "ghost", padx=8, pady=3, font=(UI_FONT, 9),
                              command=self._copy_url)
        self.reg(btn_copy, "btn.copy_url")
        btn_copy.pack(side="left")
        btn_docs = FlatButton(addr, "ghost", padx=8, pady=3, font=(UI_FONT, 9),
                              command=self._open_docs)
        self.reg(btn_docs, "btn.open_docs")
        btn_docs.pack(side="left", padx=6)

        meta = tk.Frame(inner, bg=C.PANEL)
        meta.pack(fill="x", pady=(8, 0))
        self.lbl_uptime = tk.Label(meta, text="", bg=C.PANEL, fg=C.MUTED,
                                   font=(UI_FONT, 9))
        self.lbl_uptime.pack(side="left")
        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 8),
                          wraplength=430, justify="left"),
                 "hint.extension").pack(anchor="w", pady=(8, 0))

        api = card(top)
        api.pack(side="left", fill="both", expand=True, padx=(14, 0))
        ai = tk.Frame(api, bg=C.PANEL)
        ai.pack(fill="both", expand=True, padx=16, pady=14)
        self.reg(tk.Label(ai, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9, "bold")),
                 "card.api").pack(anchor="w")
        self.lbl_api_source = tk.Label(ai, text="", bg=C.PANEL, fg=C.FG,
                                       font=(MONO_FONT, 9), justify="left",
                                       wraplength=430, anchor="w")
        self.lbl_api_source.pack(fill="x", pady=(10, 2))
        self.lbl_api_meta = tk.Label(ai, text="", bg=C.PANEL, fg=C.MUTED,
                                     font=(UI_FONT, 9), justify="left", anchor="w")
        self.lbl_api_meta.pack(fill="x")
        api_row = tk.Frame(ai, bg=C.PANEL)
        api_row.pack(fill="x", pady=(10, 0))
        self.btn_check = FlatButton(api_row, "ghost", command=self._on_check_update)
        self.reg(self.btn_check, "btn.check")
        self.btn_check.pack(side="left")
        self.btn_update = FlatButton(api_row, "accent", command=self._on_update_now)
        self.reg(self.btn_update, "btn.update")
        self.btn_update.pack(side="left", padx=6)
        self.progress = ttk.Label(ai, text="", background=C.PANEL,
                                  foreground=C.ACCENT2, font=(MONO_FONT, 9))
        self.progress.pack(anchor="w", pady=(8, 0))

        # --- log ------------------------------------------------------------
        log_card = card(parent)
        log_card.pack(fill="both", expand=True, pady=(14, 0))
        lc = tk.Frame(log_card, bg=C.PANEL)
        lc.pack(fill="both", expand=True, padx=16, pady=14)
        bar = tk.Frame(lc, bg=C.PANEL)
        bar.pack(fill="x")
        self.reg(tk.Label(bar, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9, "bold")),
                 "card.log").pack(side="left")

        self.var_autoscroll = tk.BooleanVar(value=bool(self.settings.get("autoscroll", True)))
        chk = ttk.Checkbutton(bar, variable=self.var_autoscroll, style="TP.TCheckbutton")
        self.reg(chk, "lbl.autoscroll")
        chk.pack(side="right")
        self.var_wrap = tk.BooleanVar(value=bool(self.settings.get("log_wrap", False)))
        chk_wrap = ttk.Checkbutton(bar, variable=self.var_wrap,
                                   style="TP.TCheckbutton", command=self._apply_wrap)
        self.reg(chk_wrap, "lbl.wrap")
        chk_wrap.pack(side="right", padx=(0, 14))

        self.var_filter = tk.StringVar(value=str(self.settings.get("log_level_filter", "all")))
        combo = ttk.Combobox(bar, textvariable=self.var_filter, state="readonly", width=8,
                             values=("all", "info", "ok", "warn", "err", "dbg"),
                             style="TP.TCombobox")
        combo.bind("<<ComboboxSelected>>", lambda _e: self._apply_log_filter())
        combo.pack(side="right", padx=8)
        self.reg(tk.Label(bar, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9)),
                 "lbl.filter").pack(side="right")
        for key, cmd, padx in (("btn.save_log", self._save_log, (0, 14)),
                               ("btn.copy", self._copy_log, 4),
                               ("btn.clear", self._clear_log, 0)):
            btn = FlatButton(bar, "ghost", padx=8, pady=3, font=(UI_FONT, 9),
                             command=cmd)
            self.reg(btn, key)
            btn.pack(side="right", padx=padx)

        wrap = tk.Frame(lc, bg=C.PANEL2, highlightthickness=1,
                        highlightbackground=C.BORDER)
        wrap.pack(fill="both", expand=True, pady=(10, 0))
        self.log = tk.Text(wrap, bg=C.PANEL2, fg=C.FG, bd=0, highlightthickness=0,
                           font=(MONO_FONT, 9), wrap="none", state="disabled",
                           insertbackground=C.FG, selectbackground=C.ACCENT,
                           padx=10, pady=8)
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.log.yview,
                            style="TP.Vertical.TScrollbar")
        self.log_hsb = ttk.Scrollbar(wrap, orient="horizontal", command=self.log.xview,
                                     style="TP.Horizontal.TScrollbar")
        self.log.configure(yscrollcommand=vsb.set, xscrollcommand=self.log_hsb.set)
        vsb.pack(side="right", fill="y")
        self.log_hsb.pack(side="bottom", fill="x")
        self.log.pack(side="left", fill="both", expand=True)
        for level, colour in (("info", C.FG), ("ok", C.OK), ("warn", C.WARN),
                              ("err", C.ERR), ("dbg", C.DBG)):
            self.log.tag_configure(level, foreground=colour)
        self._apply_wrap()
        self._apply_log_filter()

    # -- settings -----------------------------------------------------------
    def _page_settings(self, parent: tk.Frame) -> None:
        area = ScrollArea(parent)
        area.pack(fill="both", expand=True)
        host = area.inner

        top = card(host)
        top.pack(fill="x", pady=(0, 12))
        box = tk.Frame(top, bg=C.PANEL)
        box.pack(fill="x", padx=16, pady=14)
        tk.Label(box, text="Local endpoint", bg=C.PANEL, fg=C.MUTED,
                 font=(UI_FONT, 9, "bold")).pack(anchor="w", pady=(0, 8))
        grid = tk.Frame(box, bg=C.PANEL)
        grid.pack(fill="x")
        grid.columnconfigure(1, weight=1)
        self.vars["__host"] = tk.StringVar(value=str(self.settings.get("host", "127.0.0.1")))
        self.vars["__port"] = tk.StringVar(value=str(self.settings.get("port", 7860)))
        self._labeled_row(grid, 0, "lbl.host", self.vars["__host"], width=18)
        self._labeled_row(grid, 1, "lbl.port", self.vars["__port"], width=18)

        opts = tk.Frame(box, bg=C.PANEL)
        opts.pack(fill="x", pady=(10, 0))
        self.vars["__autostart"] = tk.BooleanVar(value=bool(self.settings.get("auto_start_server")))
        self.vars["__autocheck"] = tk.BooleanVar(value=bool(self.settings.get("auto_check_update", True)))
        self.vars["__keepkey"] = tk.BooleanVar(value=bool(self.settings.get("keep_api_key", True)))
        for key, var in (("lbl.autostart", self.vars["__autostart"]),
                         ("lbl.autocheck", self.vars["__autocheck"]),
                         ("lbl.keepkey", self.vars["__keepkey"])):
            chk = ttk.Checkbutton(opts, variable=var, style="TP.TCheckbutton")
            self.reg(chk, key)
            chk.pack(anchor="w", pady=2)

        # The generated part lives in its own container so an API update can
        # re-render it (fields appear / disappear) without restarting the app.
        self.settings_body = tk.Frame(host, bg=C.BG)
        self.settings_body.pack(fill="x")

        actions = tk.Frame(host, bg=C.BG)
        actions.pack(fill="x", pady=(0, 16))
        btn = FlatButton(actions, "accent", command=self._save_from_ui)
        self.reg(btn, "btn.apply")
        btn.pack(side="left")
        btn2 = FlatButton(actions, "ghost", command=self._reset_curated)
        self.reg(btn2, "btn.reset")
        btn2.pack(side="left", padx=8)
        self.reg(tk.Label(actions, bg=C.BG, fg=C.MUTED, font=(UI_FONT, 9)),
                 "hint.restart").pack(side="left", padx=12)
        self._render_settings_fields()

    def _render_settings_fields(self) -> None:
        """Draw the settings groups from the reconciled schema."""
        for child in self.settings_body.winfo_children():
            child.destroy()
        self._group_frames: dict[str, tk.Frame] = {}
        for spec in self.schema.specs:          # drop widgets of vanished fields
            self.vars.pop(spec.key, None)

        schema = self.schema
        if schema.hidden or schema.extra or schema.origin != "built-in":
            banner = card(self.settings_body)
            banner.pack(fill="x", pady=(0, 12))
            self.schema_banner = tk.Label(
                banner, bg=C.PANEL, fg=C.WARN if schema.hidden else C.MUTED,
                font=(UI_FONT, 9), justify="left", anchor="w", wraplength=700)
            self.schema_banner.pack(fill="x", padx=16, pady=12)
        else:
            self.schema_banner = None

        for group in schema.groups:
            specs = [s for s in schema.specs if s.group == group]
            if not specs and group != "ai":
                continue
            block = card(self.settings_body)
            block.pack(fill="x", pady=(0, 12))
            inner = tk.Frame(block, bg=C.PANEL)
            inner.pack(fill="x", padx=16, pady=14)
            title = tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9, "bold"))
            title.pack(anchor="w", pady=(0, 10))
            self._group_frames[f"{group}__title"] = title
            grid = tk.Frame(inner, bg=C.PANEL)
            grid.pack(fill="x")
            grid.columnconfigure(1, weight=1)
            self._group_frames[group] = grid
            row = 0
            for spec in specs:
                self._field_row(grid, row, spec)
                row += 2
            if group == "ai":
                # Not environment variables — the launcher patches these module
                # constants at start, so they are always available.
                for skey, label_key in (("ai_temperature", "lbl.temperature"),
                                        ("ai_max_tokens", "lbl.max_tokens")):
                    var = tk.StringVar(value=str(self.settings.get(skey, "")))
                    self.vars[f"__{skey}"] = var
                    self._labeled_row(grid, row, label_key, var, width=12)
                    row += 2
        self._rebuild_settings_labels()

    def _labeled_row(self, grid: tk.Frame, row: int, label_key: str,
                     var: tk.Variable, width: int = 24) -> None:
        lbl = tk.Label(grid, bg=C.PANEL, fg=C.FG, font=(UI_FONT, 10), anchor="w")
        self.reg(lbl, label_key)
        lbl.grid(row=row, column=0, sticky="w", pady=(4, 0), padx=(0, 14))
        entry = ttk.Entry(grid, textvariable=var, width=width, style="TP.TEntry")
        entry.grid(row=row, column=1, sticky="w", pady=(4, 0))

    def _field_row(self, grid: tk.Frame, row: int, spec: FieldSpec) -> None:
        stored = self.settings.get("env", {}).get(spec.key, "")
        label = tk.Label(grid, bg=C.PANEL, fg=C.FG, font=(UI_FONT, 10),
                         anchor="w", justify="left")
        label.grid(row=row, column=0, sticky="w", padx=(0, 16), pady=(6, 0))
        self._group_frames[f"field__{spec.key}"] = label

        if spec.kind == "bool":
            var = tk.StringVar(value=str(stored or ""))
            widget = ttk.Combobox(grid, textvariable=var, state="readonly", width=14,
                                  values=("", "true", "false"), style="TP.TCombobox")
        elif spec.kind == "choice":
            var = tk.StringVar(value=str(stored or ""))
            widget = ttk.Combobox(grid, textvariable=var, state="readonly", width=16,
                                  values=("",) + spec.choices, style="TP.TCombobox")
        elif spec.kind == "secret":
            var = tk.StringVar(value=str(stored or ""))
            widget = ttk.Entry(grid, textvariable=var, width=46, show="•",
                               style="TP.TEntry")
        else:
            var = tk.StringVar(value=str(stored or ""))
            widget = ttk.Entry(grid, textvariable=var, width=16, style="TP.TEntry")
        widget.grid(row=row, column=1, sticky="w", pady=(6, 0))
        self.vars[spec.key] = var

        hint = tk.Label(grid, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 8),
                        anchor="w", justify="left", wraplength=620)
        hint.grid(row=row + 1, column=0, columnspan=2, sticky="w")
        self._group_frames[f"hint__{spec.key}"] = hint

    def _rebuild_settings_labels(self) -> None:
        """Refresh bilingual labels/hints of the generated settings rows."""
        frames = getattr(self, "_group_frames", None)
        if not frames:
            return
        for group, (en, th) in self.schema.groups.items():
            widget = frames.get(f"{group}__title")
            if widget is not None:
                widget.configure(text=en if self.lang == "en" else th)
        for spec in self.schema.specs:
            label = frames.get(f"field__{spec.key}")
            if label is not None:
                label.configure(text=spec.en if self.lang == "en" else spec.th)
            hint = frames.get(f"hint__{spec.key}")
            if hint is not None:
                text = spec.hint_en if self.lang == "en" else spec.hint_th
                default = f"{spec.key} · default: {spec.default or '—'}"
                hint.configure(text=f"{default}  —  {text}" if text else default)
        if getattr(self, "schema_banner", None) is not None:
            self.schema_banner.configure(text=self._schema_banner_text())

    def _schema_banner_text(self) -> str:
        """Explain, in the current language, how the page adapted itself."""
        schema = self.schema
        parts: list[str] = []
        if schema.origin != "built-in":
            parts.append(f"Layout from the API's {schema.origin}" if self.lang == "en"
                         else f"ใช้เลย์เอาต์จาก {schema.origin} ของ API")
        if schema.hidden:
            names = ", ".join(schema.hidden)
            parts.append(
                f"{len(schema.hidden)} option(s) hidden — this API version no "
                f"longer reads them: {names}" if self.lang == "en" else
                f"ซ่อน {len(schema.hidden)} ตัวเลือก เพราะ API เวอร์ชันนี้ไม่ได้ใช้แล้ว: {names}")
        if schema.extra:
            parts.append(
                f"{len(schema.extra)} further option(s) are on the Advanced page"
                if self.lang == "en" else
                f"มีอีก {len(schema.extra)} ตัวเลือกอยู่ในหน้าขั้นสูง")
        return "  ·  ".join(parts)

    # -- prompt -------------------------------------------------------------
    def _page_prompt(self, parent: tk.Frame) -> None:
        block = card(parent)
        block.pack(fill="both", expand=True)
        inner = tk.Frame(block, bg=C.PANEL)
        inner.pack(fill="both", expand=True, padx=16, pady=14)

        bar = tk.Frame(inner, bg=C.PANEL)
        bar.pack(fill="x")
        self.reg(tk.Label(bar, bg=C.PANEL, fg=C.FG, font=(UI_FONT, 10)),
                 "lbl.prompt_lang").pack(side="left")
        self.var_prompt_lang = tk.StringVar(value="th")
        combo = ttk.Combobox(bar, textvariable=self.var_prompt_lang, width=10,
                             state="readonly", style="TP.TCombobox",
                             values=("th", "en", "ja", "zh", "ko", "default"))
        combo.pack(side="left", padx=8)
        combo.bind("<<ComboboxSelected>>", lambda _e: self._load_prompt_into_box(False))
        b1 = FlatButton(bar, "ghost", padx=10, pady=4, font=(UI_FONT, 9),
                        command=lambda: self._load_prompt_into_box(True))
        self.reg(b1, "btn.load_default")
        b1.pack(side="left", padx=(6, 0))
        b2 = FlatButton(bar, "ghost", padx=10, pady=4, font=(UI_FONT, 9),
                        command=self._clear_prompt_override)
        self.reg(b2, "btn.clear_override")
        b2.pack(side="left", padx=6)
        b3 = FlatButton(bar, "accent", padx=10, pady=4, font=(UI_FONT, 9),
                        command=self._save_prompt_override)
        self.reg(b3, "btn.apply")
        b3.pack(side="left")

        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 8),
                          wraplength=780, justify="left"),
                 "hint.prompt").pack(anchor="w", pady=(8, 6))

        wrap = tk.Frame(inner, bg=C.PANEL2, highlightthickness=1,
                        highlightbackground=C.BORDER)
        wrap.pack(fill="both", expand=True)
        self.prompt_box = tk.Text(wrap, bg=C.PANEL2, fg=C.FG, bd=0,
                                  highlightthickness=0, font=(MONO_FONT, 9),
                                  wrap="word", insertbackground=C.FG,
                                  selectbackground=C.ACCENT, padx=10, pady=8)
        bar2 = ttk.Scrollbar(wrap, orient="vertical", command=self.prompt_box.yview,
                             style="TP.Vertical.TScrollbar")
        self.prompt_box.configure(yscrollcommand=bar2.set)
        bar2.pack(side="right", fill="y")
        self.prompt_box.pack(side="left", fill="both", expand=True)
        self.prompt_status = tk.Label(inner, text="", bg=C.PANEL, fg=C.MUTED,
                                      font=(UI_FONT, 9))
        self.prompt_status.pack(anchor="w", pady=(8, 0))

    def _load_prompt_into_box(self, force_default: bool = False) -> None:
        lang = self.var_prompt_lang.get()
        override = (self.settings.get("prompt_overrides") or {}).get(lang, "")
        text, note = "", ""
        if override and not force_default:
            text, note = override, f"override in use ({len(override)} chars)"
        else:
            try:
                text = read_default_prompt(self._effective_api_dir(), lang)
                note = f"API default for '{lang}' ({len(text)} chars)"
            except Exception as exc:  # noqa: BLE001
                note = f"could not read the API default: {exc}"
                self.bus.emit(f"prompt: {exc}", "err")
        self.prompt_box.delete("1.0", "end")
        self.prompt_box.insert("1.0", text)
        self.prompt_status.config(text=note)

    def _save_prompt_override(self) -> None:
        lang = self.var_prompt_lang.get()
        text = self.prompt_box.get("1.0", "end").strip()
        overrides = self.settings.setdefault("prompt_overrides", {})
        if text:
            overrides[lang] = text
        else:
            overrides.pop(lang, None)
        save_settings(self.settings)
        self.prompt_status.config(text=self.t("msg.saved") + "  ·  " + self.t("hint.restart"))
        self.bus.emit(f"prompt: override saved for '{lang}' ({len(text)} chars)", "ok")

    def _clear_prompt_override(self) -> None:
        lang = self.var_prompt_lang.get()
        (self.settings.get("prompt_overrides") or {}).pop(lang, None)
        save_settings(self.settings)
        self._load_prompt_into_box(True)
        self.bus.emit(f"prompt: override removed for '{lang}'", "info")

    # -- advanced -----------------------------------------------------------
    def _page_advanced(self, parent: tk.Frame) -> None:
        head = card(parent)
        head.pack(fill="x")
        inner = tk.Frame(head, bg=C.PANEL)
        inner.pack(fill="x", padx=16, pady=12)
        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9),
                          wraplength=760, justify="left"),
                 "hint.advanced").pack(anchor="w")
        row = tk.Frame(inner, bg=C.PANEL)
        row.pack(fill="x", pady=(10, 0))
        btn = FlatButton(row, "accent", padx=10, pady=4, font=(UI_FONT, 9),
                         command=self._save_from_ui)
        self.reg(btn, "btn.apply")
        btn.pack(side="left")
        FlatButton(row, "ghost", padx=10, pady=4, font=(UI_FONT, 9), text="⟳",
                   command=self._reload_schema).pack(side="left", padx=6)
        self.btn_cleanup = FlatButton(row, "ghost", padx=10, pady=4,
                                      font=(UI_FONT, 9),
                                      command=self._cleanup_orphan_settings)
        self.reg(self.btn_cleanup, "btn.cleanup")
        self.btn_cleanup.pack(side="left", padx=6)
        self.adv_count = tk.Label(row, text="", bg=C.PANEL, fg=C.MUTED,
                                  font=(UI_FONT, 9))
        self.adv_count.pack(side="left", padx=10)

        self.adv_area = ScrollArea(parent)
        self.adv_area.pack(fill="both", expand=True, pady=(12, 0))
        self._reload_advanced()

    def _reload_advanced(self) -> None:
        for child in self.adv_area.inner.winfo_children():
            child.destroy()
        self.adv_vars.clear()
        api_dir = self._effective_api_dir()
        curated = self.schema.keys
        found = [v for v in self.schema.discovered if v.name not in curated]
        snapshot = read_env_snapshot()
        added = set(snapshot.get("added") or ())
        removed = [n for n in (snapshot.get("removed") or ())]
        orphans = self._orphan_setting_keys()

        summary = f"{len(found)} options · {api_dir}"
        if added:
            summary += f"  ·  {len(added)} new since the last update"
        if removed:
            summary += f"  ·  {len(removed)} removed"
        self.adv_count.config(text=summary)
        self.btn_cleanup.configure(
            state="normal" if orphans else "disabled",
            text=self.t("btn.cleanup") + (f" ({len(orphans)})" if orphans else ""))
        self._nav_badges["advanced"] = f"● {len(added)}" if added else ""
        self._apply_nav_badges()

        if not found:
            tk.Label(self.adv_area.inner,
                     text="No API source cached yet — fetch it from the "
                          "'Source & update' page.",
                     bg=C.BG, fg=C.MUTED, font=(UI_FONT, 10)).pack(anchor="w", pady=20)
            return

        if removed:
            note = card(self.adv_area.inner)
            note.pack(fill="x", pady=(0, 12))
            tk.Label(note, bg=C.PANEL, fg=C.WARN, font=(UI_FONT, 9), justify="left",
                     anchor="w", wraplength=700,
                     text=("The last API update removed: " if self.lang == "en"
                           else "อัปเดต API ล่าสุดเอาตัวเลือกเหล่านี้ออก: ")
                          + ", ".join(removed)).pack(fill="x", padx=16, pady=10)

        block = card(self.adv_area.inner)
        block.pack(fill="x")
        grid = tk.Frame(block, bg=C.PANEL)
        grid.pack(fill="x", padx=16, pady=14)
        grid.columnconfigure(3, weight=1)
        # New options first — they are the reason someone opens this page.
        for i, var in enumerate(sorted(found, key=lambda v: (v.name not in added,
                                                             v.name))):
            is_new = var.name in added
            tk.Label(grid, text="NEW" if is_new else "", bg=C.PANEL,
                     fg=C.OK, font=(UI_FONT, 8, "bold"), anchor="w").grid(
                row=i, column=0, sticky="w", padx=(0, 6), pady=3)
            tk.Label(grid, text=var.name, bg=C.PANEL,
                     fg=C.OK if is_new else C.FG,
                     font=(MONO_FONT, 9), anchor="w").grid(
                row=i, column=1, sticky="w", padx=(0, 12), pady=3)
            sv = tk.StringVar(value=str((self.settings.get("advanced_env") or {})
                                        .get(var.name, "")))
            self.adv_vars[var.name] = sv
            ttk.Entry(grid, textvariable=sv, width=22, style="TP.TEntry").grid(
                row=i, column=2, sticky="w", pady=3)
            tk.Label(grid, text=f"default: {var.default or '—'}   ·   {var.where}",
                     bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 8), anchor="w").grid(
                row=i, column=3, sticky="w", padx=12, pady=3)

    def _orphan_setting_keys(self) -> list[str]:
        """Stored values whose environment variable the API no longer reads."""
        if not self.schema.discovered:
            return []                      # nothing to compare against — say nothing
        known = {v.name for v in self.schema.discovered}
        stored = {k for k, v in (self.settings.get("env") or {}).items() if str(v).strip()}
        stored |= {k for k, v in (self.settings.get("advanced_env") or {}).items()
                   if str(v).strip()}
        return sorted(stored - known)

    def _cleanup_orphan_settings(self) -> None:
        orphans = self._orphan_setting_keys()
        if not orphans:
            return
        for key in orphans:
            (self.settings.get("env") or {}).pop(key, None)
            (self.settings.get("advanced_env") or {}).pop(key, None)
        save_settings(self.settings)
        self.bus.emit("settings: removed values for options this API no longer "
                      "has — " + ", ".join(orphans), "ok")
        self._reload_advanced()

    # -- source & update ----------------------------------------------------
    def _page_source(self, parent: tk.Frame) -> None:
        block = card(parent)
        block.pack(fill="x")
        inner = tk.Frame(block, bg=C.PANEL)
        inner.pack(fill="x", padx=16, pady=14)
        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.FG, font=(UI_FONT, 10, "bold")),
                 "lbl.source_url").pack(anchor="w")
        self.var_source = tk.StringVar(value=str(self.settings.get("source", DEFAULT_SOURCE)))
        row = tk.Frame(inner, bg=C.PANEL)
        row.pack(fill="x", pady=(8, 4))
        ttk.Entry(row, textvariable=self.var_source, style="TP.TEntry").pack(
            side="left", fill="x", expand=True)
        b1 = FlatButton(row, "ghost", padx=10, pady=4, font=(UI_FONT, 9),
                        command=self._browse_source)
        self.reg(b1, "btn.browse")
        b1.pack(side="left", padx=(8, 0))
        b2 = FlatButton(row, "ghost", padx=10, pady=4, font=(UI_FONT, 9),
                        command=lambda: self.var_source.set(DEFAULT_SOURCE))
        self.reg(b2, "btn.reset_source")
        b2.pack(side="left", padx=6)
        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 8),
                          wraplength=760, justify="left"),
                 "hint.source").pack(anchor="w")

        row2 = tk.Frame(inner, bg=C.PANEL)
        row2.pack(fill="x", pady=(12, 0))
        b3 = FlatButton(row2, "ghost", command=self._on_check_update)
        self.reg(b3, "btn.check")
        b3.pack(side="left")
        b4 = FlatButton(row2, "accent", command=self._on_update_now)
        self.reg(b4, "btn.update")
        b4.pack(side="left", padx=6)
        b5 = FlatButton(row2, "ghost", command=self._on_download_model)
        self.reg(b5, "btn.download_model")
        b5.pack(side="left", padx=6)

        info = card(parent)
        info.pack(fill="x", pady=(12, 0))
        ii = tk.Frame(info, bg=C.PANEL)
        ii.pack(fill="x", padx=16, pady=14)
        self.lbl_install = tk.Label(ii, text="", bg=C.PANEL, fg=C.FG,
                                    font=(MONO_FONT, 9), justify="left", anchor="w")
        self.lbl_install.pack(fill="x")
        row3 = tk.Frame(ii, bg=C.PANEL)
        row3.pack(fill="x", pady=(12, 0))
        self.reg(tk.Label(row3, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 9)),
                 "hint.cache").pack(side="left")
        tk.Label(row3, text=str(DATA_DIR), bg=C.PANEL, fg=C.ACCENT2,
                 font=(MONO_FONT, 9)).pack(side="left", padx=8)
        b6 = FlatButton(row3, "ghost", padx=10, pady=3, font=(UI_FONT, 9),
                        command=self._open_data_dir)
        self.reg(b6, "btn.open_folder")
        b6.pack(side="left")

    def _page_about(self, parent: tk.Frame) -> None:
        block = card(parent)
        block.pack(fill="both", expand=True)
        inner = tk.Frame(block, bg=C.PANEL)
        inner.pack(fill="both", expand=True, padx=20, pady=18)
        tk.Label(inner, text=f"{APP_NAME}  v{LAUNCHER_VERSION}", bg=C.PANEL,
                 fg=C.FG, font=(UI_FONT, 13, "bold")).pack(anchor="w")
        self.reg(tk.Label(inner, bg=C.PANEL, fg=C.MUTED, font=(UI_FONT, 10),
                          wraplength=740, justify="left"),
                 "about.body").pack(anchor="w", pady=(10, 16))
        rows = [
            ("Python", platform.python_version()),
            ("Platform", platform.platform()),
            ("Frozen", "yes" if getattr(sys, "frozen", False) else "no"),
            ("Data folder", str(DATA_DIR)),
            ("API cache", str(API_DIR)),
            ("Server cwd", str(RUNTIME_DIR)),
            ("Endpoints", "/health  /version  /meta  /warmup  /translate  "
                          "/translate/{id}  /ai/resolve  /ai/prompt/default  /ws"),
        ]
        grid = tk.Frame(inner, bg=C.PANEL)
        grid.pack(fill="x")
        grid.columnconfigure(1, weight=1)
        for i, (key, value) in enumerate(rows):
            tk.Label(grid, text=key, bg=C.PANEL, fg=C.MUTED,
                     font=(UI_FONT, 9)).grid(row=i, column=0, sticky="w", pady=2,
                                             padx=(0, 16))
            tk.Label(grid, text=value, bg=C.PANEL, fg=C.FG, font=(MONO_FONT, 9),
                     wraplength=640, justify="left").grid(row=i, column=1,
                                                          sticky="w", pady=2)

    # -- actions ------------------------------------------------------------
    def _collect_settings(self) -> None:
        self.settings["host"] = self.vars["__host"].get().strip() or "127.0.0.1"
        try:
            port = int(self.vars["__port"].get().strip() or 7860)
            if not 1 <= port <= 65535:
                raise ValueError(f"{port} is outside 1-65535")
            if port < 1024:
                self.bus.emit(f"settings: port {port} is privileged — Windows may "
                              f"refuse it; 1024-65535 is safer", "warn")
            self.settings["port"] = port
        except ValueError as exc:
            self.bus.emit(f"settings: port must be a number 1-65535 ({exc}) — "
                          f"keeping {self.settings.get('port')}", "err")
        self.settings["auto_start_server"] = bool(self.vars["__autostart"].get())
        self.settings["auto_check_update"] = bool(self.vars["__autocheck"].get())
        self.settings["keep_api_key"] = bool(self.vars["__keepkey"].get())
        self.settings["autoscroll"] = bool(self.var_autoscroll.get())
        self.settings["log_wrap"] = bool(self.var_wrap.get())
        self.settings["log_level_filter"] = self.var_filter.get()
        self.settings["source"] = self.var_source.get().strip() or DEFAULT_SOURCE
        self.settings["ai_temperature"] = self.vars["__ai_temperature"].get().strip()
        self.settings["ai_max_tokens"] = self.vars["__ai_max_tokens"].get().strip()
        env = self.settings.setdefault("env", {})
        for spec in self.schema.specs:
            var = self.vars.get(spec.key)
            if var is not None:
                env[spec.key] = str(var.get()).strip()
        adv = self.settings.setdefault("advanced_env", {})
        for name, var in self.adv_vars.items():
            value = str(var.get()).strip()
            if value:
                adv[name] = value
            else:
                adv.pop(name, None)

    def _save_from_ui(self) -> None:
        self._collect_settings()
        save_settings(self.settings)
        self.bus.emit("settings: saved — " + self.t("hint.restart"), "ok")

    def _reset_curated(self) -> None:
        self.settings["env"] = {}
        for spec in self.schema.specs:
            var = self.vars.get(spec.key)
            if var is not None:
                var.set("")
        save_settings(self.settings)
        self.bus.emit("settings: cleared — the API's own defaults will be used", "info")

    def _current_source(self) -> Source | None:
        try:
            return parse_source(self.var_source.get())
        except ValueError as exc:
            self.bus.emit(f"source: {exc}", "err")
            messagebox.showerror(APP_NAME, str(exc))
            return None

    def _reload_schema(self) -> None:
        """Re-read the API source and redraw the pages it drives.

        Called after an update so options the new version added appear — and
        ones it dropped disappear — without restarting the launcher.
        """
        self.schema = build_schema(self._effective_api_dir())
        for level, message in self.schema.notes:
            self.bus.emit(message, level)
        if hasattr(self, "settings_body"):
            self._render_settings_fields()
        if hasattr(self, "adv_area"):
            self._reload_advanced()
        self._apply_nav_badges()

    def _apply_nav_badges(self) -> None:
        """Put a count next to a nav entry that has something to look at."""
        for name, badge in self._nav_badges.items():
            btn = self._nav_buttons.get(name)
            if btn is None:
                continue
            base = self.t(f"nav.{name}")
            btn.configure(text=f"{base}   {badge}" if badge else base)

    def _effective_api_dir(self) -> Path:
        """The folder the server will import from.

        Normally the private cache; a local-folder source is used in place so
        code changes are picked up without a copy step.
        """
        raw = self.var_source.get() if hasattr(self, "var_source") else \
            str(self.settings.get("source", DEFAULT_SOURCE))
        try:
            source = parse_source(raw)
        except ValueError:
            return API_DIR
        if source.kind == "local" and source.local is not None:
            return source.local
        return API_DIR

    def _on_start(self) -> None:
        self._collect_settings()
        save_settings(self.settings)
        api_dir = self._effective_api_dir()
        if not (api_dir / "backend" / "main.py").is_file():
            self.bus.emit("server: no API source cached — fetching it now", "info")
            self._run_bg(self._do_update, then=lambda ok: ok and self._on_start())
            return
        self.controller.start(self.settings, api_dir)

    def _on_stop(self) -> None:
        self.controller.stop()

    def _on_restart(self) -> None:
        def worker() -> None:
            self.controller.stop()
            self.controller.wait_stopped(25)
            self.after(300, self._on_start)

        threading.Thread(target=worker, daemon=True).start()

    def _on_check_update(self) -> None:
        source = self._current_source()
        if source is None:
            return

        def work() -> None:
            try:
                result = self.updater.check(source)
            except Exception as exc:  # noqa: BLE001
                self.bus.emit(f"update: check failed — {exc}", "err")
                return
            remote = result.get("remote") or {}
            if result["update_available"]:
                self.bus.emit(
                    "update: available"
                    + (f" — {remote.get('sha', '')[:8]} {remote.get('date', '')} "
                       f"{remote.get('message', '')}" if remote else ""),
                    "ok")
                self.after(0, lambda: self._ask_update(remote))
            else:
                self.bus.emit(
                    f"update: up to date ({result['local_sha'][:8]})", "ok")

        threading.Thread(target=work, daemon=True).start()

    def _ask_update(self, remote: dict[str, str]) -> None:
        detail = f"{remote.get('sha', '')[:8]}  {remote.get('date', '')}\n" \
                 f"{remote.get('message', '')}"
        if messagebox.askyesno(APP_NAME, f"{self.t('msg.update_found')}\n\n{detail}"):
            self._on_update_now()

    def _on_update_now(self) -> None:
        if self.controller.is_busy():
            messagebox.showwarning(APP_NAME, self.t("msg.stop_first"))
            return
        self._run_bg(self._do_update)

    def _do_update(self) -> bool:
        source = self._current_source()
        if source is None:
            return False
        self._collect_settings()
        save_settings(self.settings)
        try:
            self.updater.install(source, progress=self._progress)
            added, removed = record_env_snapshot(
                discover_env_vars(self._effective_api_dir()))
            if added:
                self.bus.emit(f"update: this version adds {len(added)} setting(s) — "
                              + ", ".join(added), "ok")
            if removed:
                self.bus.emit(f"update: this version drops {len(removed)} setting(s) — "
                              + ", ".join(removed), "warn")
            if not added and not removed:
                self.bus.emit("update: the available settings are unchanged", "info")
            self.after(0, self._refresh_api_card)
            self.after(0, self._reload_schema)
            return True
        except Exception as exc:  # noqa: BLE001
            self.bus.emit(f"update: FAILED — {exc}", "err")
            self.after(0, lambda: messagebox.showerror(APP_NAME, str(exc)))
            return False
        finally:
            self.after(0, lambda: self.progress.configure(text=""))

    def _on_download_model(self) -> None:
        url = (self.settings.get("advanced_env", {}).get("TP_TEXTBLOCK_MODEL_URL")
               or MODEL_URL_DEFAULT)

        def work() -> None:
            try:
                self.updater.download_model(url, self._progress)
            except Exception as exc:  # noqa: BLE001
                self.bus.emit(f"model: download failed — {exc}", "err")
            finally:
                self.after(0, lambda: self.progress.configure(text=""))

        threading.Thread(target=work, daemon=True).start()

    def _progress(self, done: int, total: int) -> None:
        mb = done / 1048576
        text = (f"{mb:.1f} / {total / 1048576:.1f} MB "
                f"({done * 100 // max(1, total)}%)") if total else f"{mb:.1f} MB"
        self.after(0, lambda: self.progress.configure(text=text))

    def _run_bg(self, fn: Callable[[], bool],
                then: Callable[[bool], Any] | None = None) -> None:
        def work() -> None:
            ok = False
            try:
                ok = bool(fn())
            finally:
                if then is not None:
                    self.after(0, lambda: then(ok))

        threading.Thread(target=work, daemon=True).start()

    def _browse_source(self) -> None:
        folder = filedialog.askdirectory(title="Select the api folder")
        if folder:
            self.var_source.set(folder)

    def _open_data_dir(self) -> None:
        ensure_dirs()
        try:
            if os.name == "nt":
                os.startfile(str(DATA_DIR))  # noqa: S606
            elif sys.platform == "darwin":
                os.system(f'open "{DATA_DIR}"')  # noqa: S605
            else:
                os.system(f'xdg-open "{DATA_DIR}"')  # noqa: S605
        except Exception as exc:  # noqa: BLE001
            self.bus.emit(f"open folder failed: {exc}", "err")

    def _copy_url(self) -> None:
        url = self.controller.url or self._planned_url()
        self.clipboard_clear()
        self.clipboard_append(url)
        self.bus.emit(f"copied: {url}", "dbg")

    def _open_docs(self) -> None:
        webbrowser.open((self.controller.url or self._planned_url()) + "/docs")

    def _planned_url(self) -> str:
        host = self.vars["__host"].get().strip() or "127.0.0.1"
        port = self.vars["__port"].get().strip() or "7860"
        return f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}"

    def _copy_log(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(self.log.get("1.0", "end"))

    def _clear_log(self) -> None:
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")
        self._log_lines = 0

    def _save_log(self) -> None:
        path = filedialog.asksaveasfilename(
            defaultextension=".txt", initialfile="textphantom-log.txt",
            filetypes=[("Text", "*.txt"), ("All files", "*.*")])
        if not path:
            return
        Path(path).write_text(self.log.get("1.0", "end"), encoding="utf-8")
        self.bus.emit(f"log saved: {path}", "ok")

    # -- periodic UI updates ------------------------------------------------
    def _apply_wrap(self) -> None:
        """Word-wrap long lines, or keep them on one line with a scrollbar."""
        wrapping = bool(self.var_wrap.get())
        self.log.configure(wrap="word" if wrapping else "none")
        if wrapping:
            self.log_hsb.pack_forget()
        else:
            self.log_hsb.pack(side="bottom", fill="x")

    def _apply_log_filter(self) -> None:
        """Hide the levels the user filtered out — without discarding them.

        The lines stay in the widget and simply become elided, so switching
        the filter back shows the history again instead of an empty pane.
        """
        wanted = self.var_filter.get()
        for level in LEVELS:
            self.log.tag_configure(level, elide=(wanted != "all" and level != wanted))
        if self.var_autoscroll.get():
            self.log.see("end")

    def _tick(self) -> None:
        rows = self.bus.drain()
        if rows:
            self.log.configure(state="normal")
            for level, line in rows:
                self.log.insert("end", line + "\n", level)
                self._log_lines += 1
            if self._log_lines > 6000:
                self.log.delete("1.0", "2001.0")  # drop the oldest 2000 lines
                # Trust the widget, not a counter that can drift.
                self._log_lines = int(self.log.index("end-1c").split(".")[0])
            self.log.configure(state="disabled")
            if self.var_autoscroll.get():
                self.log.see("end")
        if self.controller.started_at:
            secs = int(time.time() - self.controller.started_at)
            self.lbl_uptime.config(
                text=f"{self.t('lbl.uptime')}: "
                     f"{secs // 3600:02d}:{secs % 3600 // 60:02d}:{secs % 60:02d}")
        else:
            self.lbl_uptime.config(text="")
        self.after(180, self._tick)

    def _on_server_state(self, state: str, detail: str) -> None:
        self.after(0, lambda: self._refresh_status(state, detail))

    def _refresh_status(self, state: str | None = None, detail: str = "") -> None:
        state = state or self.controller.state
        colour = STATE_COLORS.get(state, C.MUTED)
        self.status_dot.config(fg=colour)
        label = self.t(f"state.{state}")
        self.status_text.config(text=label + (f" · {detail}" if detail and
                                              state == STATE_ERROR else ""))
        self.lbl_url.config(text=self.controller.url or self._planned_url())
        running = state in (STATE_RUNNING, STATE_STARTING)
        self.btn_start.config(state="disabled" if running else "normal")
        self.btn_stop.config(state="normal" if running else "disabled")
        for btn in (self.btn_update,):
            btn.config(state="disabled" if running else "normal")

    def _refresh_api_card(self) -> None:
        info = read_install_info()
        if not info:
            self.lbl_api_source.config(text=self.var_source.get() if
                                       hasattr(self, "var_source") else DEFAULT_SOURCE)
            self.lbl_api_meta.config(text=self.t("lbl.never"))
            if hasattr(self, "lbl_install"):
                self.lbl_install.config(text=self.t("lbl.never"))
            return
        self.lbl_api_source.config(text=str(info.get("source_label", "")))
        sha = str(info.get("sha", ""))
        meta = (f"{self.t('lbl.installed')}: {info.get('installed_at', '?')}   ·   "
                f"{self.t('lbl.commit')}: {sha[:8] or '—'}   ·   "
                f"{self.t('lbl.files')}: {info.get('files', '—')}")
        self.lbl_api_meta.config(text=meta)
        if hasattr(self, "lbl_install"):
            self.lbl_install.config(
                text="\n".join([
                    f"{self.t('lbl.installed')} : {info.get('installed_at', '?')}",
                    f"{self.t('lbl.commit')}    : {sha or '—'}",
                    f"                 {info.get('commit_date', '')} "
                    f"{info.get('commit_message', '')}",
                    f"{self.t('lbl.files')}     : {info.get('files', '—')}",
                    f"path      : {info.get('path', str(API_DIR))}",
                ]))

    # -- start-up / shutdown ------------------------------------------------
    def _first_run(self) -> None:
        self._refresh_status()
        self._refresh_api_card()
        self._load_prompt_into_box(False)
        if self.schema.discovered and not read_env_snapshot():
            # Baseline for the "what did this update change?" report.
            record_env_snapshot(self.schema.discovered)
        if not (self._effective_api_dir() / "backend" / "main.py").is_file():
            self.bus.emit(
                "no API source cached yet — press 'Update now' (or 'Start', "
                "which fetches it first)", "warn")
            self._show_page("source")
        elif self.settings.get("auto_check_update", True):
            self._on_check_update()
        if self.settings.get("auto_start_server"):
            self.after(1200, self._on_start)

    def _on_close(self) -> None:
        if self.controller.is_busy():
            if not messagebox.askyesno(APP_NAME, self.t("msg.confirm_quit")):
                return
            self.controller.stop()
            self.controller.wait_stopped(12)
        try:
            self._collect_settings()
            save_settings(self.settings)
        except Exception as exc:  # noqa: BLE001
            print(f"settings not saved: {exc}")
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        self.destroy()


class SingleInstance:
    """One window per user — a second launch would fight over the same port.

    Uses a real file lock, so a crashed process releases it automatically
    (unlike a "is this PID alive?" check, which guesses).
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle: Any = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = open(self.path, "a+")  # noqa: SIM115 - held for the run
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._handle.close()
            self._handle = None
            return False
        except ImportError as exc:  # no locking primitive on this platform
            print(f"single-instance check unavailable ({exc}); "
                  f"a second window would clash on the port", flush=True)
        return True


def main() -> int:
    ensure_dirs()
    lock = SingleInstance(DATA_DIR / "instance.lock")
    if not lock.acquire():
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(
            APP_NAME,
            f"{APP_NAME} is already running.\n"
            f"{APP_NAME} เปิดอยู่แล้ว — ดูที่แถบงาน (taskbar)")
        root.destroy()
        return 0
    app = App()
    app.mainloop()
    return 0


if __name__ == "__main__":
    if os.name == "nt":
        try:
            import multiprocessing

            multiprocessing.freeze_support()
        except Exception:  # noqa: BLE001
            pass
    raise SystemExit(main())
