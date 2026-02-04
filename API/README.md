---
title: TextPhantom OCR API
emoji: "🪄"
colorFrom: indigo
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
---

FastAPI backend for TextPhantom (Chrome extension).

## Endpoints

- `GET /health`
- `GET /version`
- `GET /warmup?lang=th`
- `POST /translate`
- `GET /translate/{job_id}`
- `POST /ai/resolve`
- `GET /ai/models`
- `POST /ws` (WebSocket)

## Environment

- `AI_API_KEY` (optional)
- `SERVER_MAX_WORKERS` (default: 15)
- `JOB_TTL_SEC` (default: 3600)
- `TP_DEBUG` (set to `1` to enable debug logs)

For Spaces on small CPU, setting `SERVER_MAX_WORKERS=2` is usually enough.
