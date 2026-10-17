"""Real-socket harness for API admission tests (2026.10.16.3).

Starts the real FastAPI app under uvicorn in a background thread with Google
Lens and the boot warmup stubbed, so tests can drive real HTTP behaviour that
an in-process client cannot: client disconnects, mid-upload aborts, many
concurrent clients from different addresses.

Import order matters: call :func:`prepare_env` BEFORE importing ``backend``.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "api"


def prepare_env(**extra: str) -> None:
    os.environ.setdefault("TP_ACCESS_LOG_MODE", "summary")
    os.environ.setdefault("TP_ALLOW_PRIVATE_IMAGE_HOSTS", "1")
    os.environ.setdefault("TP_IDENTITY_QUOTAS", "0")
    os.environ.setdefault("TP_LOG_FILE", "0")
    os.environ.setdefault("TP_TRACE", "0")
    for key, value in extra.items():
        os.environ[key] = value
    if str(API) not in sys.path:
        sys.path.insert(0, str(API))


class LensStub:
    """Replaces backend.lens.client.fetch_lens_data; counts concurrency."""

    def __init__(self, delay: float = 0.05) -> None:
        self.delay = delay
        self.lock = threading.Lock()
        self.inflight = 0
        self.peak = 0
        self.calls = 0
        self.behaviour = None  # optional callable(call_index) -> None, may raise/sleep

    def __call__(self, path, lang, firebase_url=None):
        from PIL import Image
        with Image.open(path) as im:
            im.size
        with self.lock:
            self.inflight += 1
            self.calls += 1
            index = self.calls
            self.peak = max(self.peak, self.inflight)
        try:
            if self.behaviour is not None:
                self.behaviour(index)
            time.sleep(self.delay)
            return {"imageUrl": None, "originalParagraphs": [], "translatedParagraphs": [],
                    "originalTextFull": "", "translatedTextFull": "", "originalContentLanguage": "ja"}
        finally:
            with self.lock:
                self.inflight -= 1


class EventLog:
    """Captures backend.log event lines (``[TextPhantom][ok|err] tag {json}``)."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.lock = threading.Lock()

    def install(self) -> None:
        from backend import log
        def capture(*args, **kwargs):
            text = " ".join(str(a) for a in args)
            with self.lock:
                self.lines.append(text)
        log.print = capture  # module-global shadow of builtins.print

    def events(self, tag: str) -> list[dict]:
        out = []
        with self.lock:
            lines = list(self.lines)
        for line in lines:
            marker = f"] {tag} "
            if marker in line:
                try:
                    out.append(json.loads(line.split(marker, 1)[1]))
                except ValueError:
                    pass
        return out

    def tags(self) -> list[str]:
        with self.lock:
            return [line.split("] ", 2)[2].split(" ", 1)[0] for line in self.lines if line.count("] ") >= 2]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, lens_delay: float = 0.05) -> None:
        from backend.lens import client as lens_client
        from backend import main
        self.main = main
        self.lens = LensStub(lens_delay)
        lens_client.fetch_lens_data = self.lens
        main.run_warmup = lambda lang=None: {"lang": lang, "cookie_ok": True, "fonts_ok": True}
        from backend.lens import cookie
        cookie.configured = lambda *a, **k: True
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        import uvicorn
        config = uvicorn.Config(main.app, host="127.0.0.1", port=self.port, log_level="warning",
                                proxy_headers=False, lifespan="on")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> "Server":
        self.thread.start()
        deadline = time.time() + 20
        while time.time() < deadline and not self.server.started:
            time.sleep(0.02)
        if not self.server.started:
            raise RuntimeError("uvicorn did not start")
        return self

    def __exit__(self, *exc) -> None:
        self.server.should_exit = True
        self.thread.join(10)

    @property
    def state(self):
        return self.main.app.state

    def gates(self) -> dict:
        s = self.state
        return {"lens": s.admission_gate, "grouping": s.grouping_admission_gate,
                "ai": s.ai_admission_gate, "login_ai": s.login_admission_gate,
                "pipeline": s.pipeline_admission_gate, "image_fetch": s.image_fetch_admission_gate}

    def call_on_loop(self, fn):
        """Run fn() on the server's event loop thread (gate state lives there)."""
        import asyncio
        from backend.jobs import stage_admission
        loop = stage_admission._loop
        async def run():
            return fn()
        return asyncio.run_coroutine_threadsafe(run(), loop).result(5)

    def quiescent(self, timeout: float = 10.0) -> dict:
        """Wait until every lane is idle; return the final counters."""
        from backend.jobs.admission import waiting_bytes
        from backend import cancellation
        deadline = time.time() + timeout
        snap = {}
        while time.time() < deadline:
            snap = self.call_on_loop(lambda: {
                **{name: g.invariants() for name, g in self.gates().items()},
                "waitingBytes": waiting_bytes.total,
                "waitingBytesOwners": len(waiting_bytes.by),
                "goneRegistry": len(cancellation._gone),
            })
            idle = all(v["running"] == 0 and v["waiting"] == 0 and v["consistent"] and v["staleServed"] == 0
                       for k, v in snap.items() if isinstance(v, dict)) \
                and snap["waitingBytes"] == 0 and snap["waitingBytesOwners"] == 0 and snap["goneRegistry"] == 0
            if idle:
                snap["idle"] = True
                return snap
            time.sleep(0.05)
        snap["idle"] = False
        return snap


def jpeg_data_uri(seed: int, size=(400, 600)) -> str:
    import base64, io, random
    from PIL import Image
    rnd = random.Random(seed)
    im = Image.new("RGB", size, (seed % 256, rnd.randrange(256), rnd.randrange(256)))
    buf = io.BytesIO()
    im.save(buf, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def runsapi_payload(seed: int, *, session: str = "", src: str = "", data_uri: str | None = None) -> dict:
    import uuid
    image = jpeg_data_uri(seed) if data_uri is None else data_uri
    payload = {"mode": "lens_images", "lang": "th", "source": "translated", "engine": "api",
               "src": src or f"https://x.test/{seed}.jpg",
               "context": {"page_url": "https://x.test/", **({"tp_tab_session": session} if session else {})},
               "metadata": {"image_id": str(uuid.uuid4()), "batch_id": "b-" + (session or "anon")}}
    if image:
        payload["imageDataUri"] = image
    return payload
