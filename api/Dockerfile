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
#
# The URL is an ARG, not a literal, so the model is chosen in ONE place per
# deployment instead of being pinned here and overridden at runtime (which
# would download a second model on every cold boot and waste the bake).
# Hugging Face passes Space *variables* to the Docker build as build-args and
# also injects them into the running container, so setting a Space variable
# named TP_TEXTBLOCK_MODEL_URL switches the baked model and the backend's
# view of it together. Keep this default in sync with `textblock_model_url`
# in backend/config.py.
#
#   nano  (default) .../onnx/yolo26n.onnx  — mAP50 0.947, 2-3x faster on CPU
#   small           .../onnx/yolo26s.onnx  — mAP50 0.961
ARG TP_TEXTBLOCK_MODEL_URL=https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/onnx/yolo26s.onnx
RUN mkdir -p models \
  && MODEL_URL="${TP_TEXTBLOCK_MODEL_URL}" python -c "import urllib.request, os; url = os.environ['MODEL_URL']; print('baking text-block model from', url); urllib.request.urlretrieve(url, 'models/manga-bubble-yolo.onnx'); s = os.path.getsize('models/manga-bubble-yolo.onnx'); assert s > 1000000, s; print('text-block model baked into image:', s, 'bytes')"

# Carry the build-time choice into the runtime environment. Without this, a
# plain `docker build --build-arg ...` would bake one model while the backend
# still believed the config.py default was in `models/` — and the two only
# disagree silently, because the file is already present so nothing re-downloads.
ENV TP_TEXTBLOCK_MODEL_URL=${TP_TEXTBLOCK_MODEL_URL}

COPY backend ./backend

ENV PORT=7860
EXPOSE 7860

CMD ["bash", "-lc", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --no-access-log --log-level warning --ws-ping-interval 45 --ws-ping-timeout 45"]
