FROM python:3.11-slim

WORKDIR /app

# libgl1 / libglib2.0-0 are needed by opencv-python-headless.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Manga text-block detector (Kiuyha/Manga-Bubble-YOLO, Apache-2.0) — baked
# into the image at BUILD time so boot never depends on a runtime download.
# The backend's auto-download (backend/render/textblocks.py) remains as a
# fallback when TP_TEXTBLOCK_MODEL points somewhere else.
# NON-FATAL: if the external model download fails/moves, do NOT abort the whole
# build — the backend downloads it lazily at runtime (backend/render/textblocks.py).
# A failed prebake just means the first AI-text request pays a one-time fetch.
RUN mkdir -p models \
  && (python -c "import urllib.request, os; urllib.request.urlretrieve('https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/onnx/yolo26s.onnx', 'models/manga-bubble-yolo.onnx'); s = os.path.getsize('models/manga-bubble-yolo.onnx'); assert s > 1000000, s; print('text-block model baked into image:', s, 'bytes')" \
      || echo 'WARN: text-block model prebake failed; runtime fallback will fetch it')

COPY backend ./backend

ENV PORT=7860
EXPOSE 7860

# NOTE: --log-level info (was warning) so the container prints "Uvicorn running
# on 0.0.0.0:7860" + the app's boot line + any startup traceback. Turn back to
# warning once the Space is healthy again.
CMD ["bash", "-lc", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --no-access-log --log-level info --ws-ping-interval 45 --ws-ping-timeout 45"]
