import os, uuid, asyncio, logging
from datetime import datetime, timedelta
from typing import Dict, Optional, List, Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl, root_validator, ValidationError
from fastapi.encoders import jsonable_encoder

from app.lens_images_core import translate_lens, _cookie_header as img_cookie_header
from app.lens_text_core   import translate_lens_text, prewarm_driver as text_prewarm

PORT              = int(os.getenv("PORT", 8080))
MAX_WORKERS       = int(os.getenv("MAX_WORKERS", 8))
MAX_WORKERS_IMAGES = int(os.getenv("MAX_WORKERS_IMAGES", MAX_WORKERS))
MAX_WORKERS_TEXT   = int(os.getenv("MAX_WORKERS_TEXT", 3))
RESULTS_TTL       = int(os.getenv("RESULTS_TTL_SECONDS", 300))
MAX_B64_IMG_LEN   = int(os.getenv("MAX_BASE64_IMAGE_LENGTH", 5_000_000))
JOB_DELAY_SEC     = int(os.getenv("JOB_DELAY_SECONDS", 0.1))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
log = logging.getLogger("ocr_ws")

ENABLE_BACKGROUND_WORKERS = os.getenv("ENABLE_BACKGROUND_WORKERS", "1").strip().lower() in ("1","true","yes","on")

workers_started: bool = False
_workers_lock = asyncio.Lock()

async def ensure_workers_started():
    global workers_started
    if workers_started:
        return
    async with _workers_lock:
        if workers_started:
            return
        for _ in range(MAX_WORKERS_IMAGES):
            asyncio.create_task(worker("lens_images", jobq_img))
        for _ in range(MAX_WORKERS_TEXT):
            asyncio.create_task(worker("lens_text", jobq_text))
        workers_started = True
        log.info("workers started on-demand")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"])

jobq_img:  asyncio.Queue = asyncio.Queue()
jobq_text: asyncio.Queue = asyncio.Queue()

class Position(BaseModel):
    top: float; left: float; width: float; height: float
    viewport_width: int; viewport_height: int
    scroll_x: float; scroll_y: float

class PipelineEvent(BaseModel):
    stage: str; at: datetime; target: Optional[str] = None

class Context(BaseModel):
    page_url: Optional[HttpUrl] = None
    timestamp: Optional[datetime] = None

class Metadata(BaseModel):
    image_id: str
    original_image_url: Optional[HttpUrl] = None
    position: Optional[Position] = None
    pipeline: List[PipelineEvent] = []
    ocr_image: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None

    @root_validator(pre=True)
    def _no_blob_urls(cls, v):
        url = v.get("original_image_url")
        
        if not url:
            v["original_image_url"] = None
            return v
        if isinstance(url, str) and url.startswith("blob:"):
            raise ValueError("original_image_url must be http(s)")
        return v

class Job(BaseModel):
    mode: str = "lens_images"
    lang: str = "en"
    type: str = "image"
    src: Optional[HttpUrl] = None
    menu: Optional[str] = None
    context: Optional[Context] = None
    metadata: Metadata

    @root_validator(pre=True)
    def _src_no_blob(cls, v):
        s = v.get("src")
        if not s:
            v["src"] = None
            return v
        if isinstance(s, str) and s.startswith("blob:"):
            raise ValueError("src must be http(s)")
        return v

class WsMessage(BaseModel):
    type: str
    id: Optional[str] = None
    payload: Optional[Job] = None

jobq: asyncio.Queue = asyncio.Queue()
pending_ws: Dict[str, WebSocket] = {}   
results: Dict[str, dict]      = {}    

@app.api_route("/health", methods=["GET", "HEAD"])
async def health():
    return {"ok": True, "timestamp": datetime.utcnow().isoformat()}

@app.post("/translate")
async def translate(job: Job):
    await ensure_workers_started()
    if job.mode not in ("lens_images", "lens_text"):
        raise HTTPException(400, "unsupported mode")
    jid = uuid.uuid4().hex
    job.metadata.pipeline.append(PipelineEvent(stage="received_rest", at=datetime.utcnow()))
    
    if job.mode == "lens_images":
        await jobq_img.put((jid, job))
    else:
        await jobq_text.put((jid, job))
    results[jid] = {"status": "queued", "_created_at": datetime.utcnow()}
    return {"id": jid, "status": "queued"}


@app.get("/translate/{jid}")
async def poll(jid: str):
    if jid not in results:
        raise HTTPException(404)
    payload = results[jid].copy(); payload.pop("_created_at", None)
    return {"id": jid, **payload}

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    await ensure_workers_started()
    try:
        while True:
            raw = await ws.receive_json()
            try:
                msg = WsMessage(**raw)
            except ValidationError as ve:
                await ws.send_json({"type": "error","detail": ve.errors()})
                continue
            match msg.type:
                case "job":
                    jid = msg.id or uuid.uuid4().hex
                    pending_ws[jid] = ws
                    await ws.send_json(jsonable_encoder({"type": "ack", "id": jid}))
                    
                    if msg.payload.mode == "lens_images":
                        await jobq_img.put((jid, msg.payload))
                    elif msg.payload.mode == "lens_text":
                        await jobq_text.put((jid, msg.payload))
                    else:
                        await ws.send_json({"type": "error","detail": "unsupported_mode"})
                        pending_ws.pop(jid, None)
                        continue
                    results[jid] = {"status": "queued", "_created_at": datetime.utcnow()}
                case _:
                    await ws.send_json({"type": "error","detail": "unknown_type"})
    except WebSocketDisconnect:
        pass
    finally:
        for jid, sock in list(pending_ws.items()):
            if sock is ws:
                pending_ws.pop(jid, None)

async def worker(mode: str, q: asyncio.Queue):
    while True:
        jid, job = await q.get()
        try:
            job.metadata.pipeline.append(PipelineEvent(stage="worker_start", at=datetime.utcnow()))
            if not job.src:
                raise RuntimeError("src missing")

            log.info("worker start %s mode=%s src=%s", jid, job.mode, job.src)
            if mode == "lens_images":
                res = await translate_lens(str(job.src), job.lang)
            elif mode == "lens_text":
                res = await translate_lens_text(str(job.src))
            else:
                raise RuntimeError(f"unsupported mode {mode}")

            img_b64 = res.get("image")
            if img_b64 and len(img_b64) > MAX_B64_IMG_LEN:
                res.pop("image", None)
                job.metadata.extra = job.metadata.extra or {}
                job.metadata.extra.setdefault(job.mode, {})["dropped_ocr_image_due_to_size"] = True

            job.metadata.pipeline.append(PipelineEvent(stage="translated", at=datetime.utcnow()))
            payload = {**res, "metadata": job.metadata.dict()}
            serial = jsonable_encoder({"type": "result", "id": jid, "result": payload})

            ws = pending_ws.pop(jid, None)
            if ws:
                try:
                    await ws.send_json(serial)
                    log.info("sent WS result %s", jid)
                except Exception:
                    pending_ws.pop(jid, None)

            results[jid] = {"status": "done", "result": payload, "_created_at": datetime.utcnow()}
            log.info("worker done %s mode=%s", jid, job.mode)
        except Exception as e:
            log.exception("worker error %s", jid, exc_info=e)
            err_txt  = (str(e) or e.__class__.__name__)
            err_type = e.__class__.__name__
            err = {"type": "error", "id": jid, "error": err_txt, "error_type": err_type}
            ws = pending_ws.pop(jid, None)
            if ws:
                try: await ws.send_json(jsonable_encoder(err))
                except Exception: pass
            results[jid] = {"status": "error", "result": err_txt, "error_type": err_type, "_created_at": datetime.utcnow()}
        finally:
            q.task_done()
            if JOB_DELAY_SEC > 0:
                await asyncio.sleep(JOB_DELAY_SEC)

async def cleanup():
    while True:
        await asyncio.sleep(60)
        cutoff = datetime.utcnow() - timedelta(seconds=RESULTS_TTL)
        for jid in [k for k,v in results.items() if v.get("_created_at") < cutoff]:
            results.pop(jid, None)
            
async def keep_warm_loop():
    while True:
        try:
            await img_cookie_header()
            await text_prewarm()
        except Exception as e:
            log.warning("keep_warm skipped: %s", e)
        await asyncio.sleep(600) 

@app.on_event("startup")
async def startup():
    if ENABLE_BACKGROUND_WORKERS:
        for _ in range(MAX_WORKERS_IMAGES):
            asyncio.create_task(worker("lens_images", jobq_img))
        for _ in range(MAX_WORKERS_TEXT):
            asyncio.create_task(worker("lens_text", jobq_text))
    asyncio.create_task(cleanup())
    asyncio.create_task(keep_warm_loop())
    log.info(
        "startup OK – %d image workers, %d text workers, TTL=%ds (workers_enabled=%s)",
        MAX_WORKERS_IMAGES, MAX_WORKERS_TEXT, RESULTS_TTL, ENABLE_BACKGROUND_WORKERS
    )
