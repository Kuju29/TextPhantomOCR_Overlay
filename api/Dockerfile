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
RUN mkdir -p models \
  && python -c "import urllib.request, os; urllib.request.urlretrieve('https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/onnx/yolo26s.onnx', 'models/manga-bubble-yolo.onnx'); s = os.path.getsize('models/manga-bubble-yolo.onnx'); assert s > 1000000, s; print('text-block model baked into image:', s, 'bytes')"

COPY backend ./backend

ENV PORT=7860
EXPOSE 7860

CMD ["bash", "-lc", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --no-access-log --log-level warning"]
