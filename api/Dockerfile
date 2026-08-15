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
ARG TP_TEXTBLOCK_MODEL_URL=https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/onnx/yolo26n.onnx
RUN mkdir -p models \
  && MODEL_URL="${TP_TEXTBLOCK_MODEL_URL}" python -c "import urllib.request, os; url = os.environ['MODEL_URL']; print('baking text-block model from', url); urllib.request.urlretrieve(url, 'models/manga-bubble-yolo.onnx'); s = os.path.getsize('models/manga-bubble-yolo.onnx'); assert s > 1000000, s; print('text-block model baked into image:', s, 'bytes')"

# Carry the build-time choice into the runtime environment. Without this, a
# plain `docker build --build-arg ...` would bake one model while the backend
# still believed the config.py default was in `models/` — and the two only
# disagree silently, because the file is already present so nothing re-downloads.
ENV TP_TEXTBLOCK_MODEL_URL=${TP_TEXTBLOCK_MODEL_URL}

# Fonts, baked in for the same reason as the model: so no request pays for a
# download and no deployment depends on notofonts.github.io being reachable.
#
# `font_config.THAI_PATH` is the bare filename "NotoSansThai-Regular.ttf",
# resolved against the working directory — which is why these land in /app and
# not in a subfolder. Without them `ensure_font` would try to WRITE the
# downloaded font here, and on a hosted runtime the app directory is usually
# not writable by the runtime user (Hugging Face Spaces runs containers as uid
# 1000, while WORKDIR is created by root). The write fails, and Pillow's bitmap
# default takes over — which returns a fixed-size box from `textbbox` no matter
# what size was asked for, so every fit calculation downstream is quietly wrong
# and Thai renders as tofu. A font that must be fetched at runtime is a
# rendering bug waiting for a bad network.
COPY NotoSansThai-Regular.ttf NotoSans-Regular.ttf ./

# Fail the BUILD, not the first request, if the two fonts are not real ones.
RUN python -c "from PIL import ImageFont; [print(p, ImageFont.truetype(p, 24).getbbox('Aก')) for p in ('NotoSansThai-Regular.ttf','NotoSans-Regular.ttf')]"

COPY build-manifest.json ./build-manifest.json
COPY backend ./backend

# Diagnostic log FILES stay off in a container: the filesystem is ephemeral (or
# read-only), and the host already collects stdout. `TP_LOG_FILE=1` turns them
# back on for a local docker run.
ENV TP_LOG_FILE=0

ENV PORT=7860
EXPOSE 7860

CMD ["bash", "-lc", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --no-access-log --log-level warning --ws-ping-interval 45 --ws-ping-timeout 45"]
