#!/usr/bin/env bash
# Build the single-file binary on Linux / macOS (same flags as build_exe.bat).
set -euo pipefail
cd "$(dirname "$0")"

python3 -c 'import tkinter' 2>/dev/null || {
  echo "[x] tkinter is missing. Debian/Ubuntu: sudo apt install python3-tk"
  exit 1
}

[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
pip install -r requirements-launcher.txt

pyinstaller --noconfirm --clean --onefile --windowed \
  --name TextPhantomLocalAPI \
  --distpath dist --workpath build --specpath build \
  --collect-all onnxruntime \
  --collect-all cv2 \
  --collect-all budoux \
  --collect-submodules uvicorn \
  --collect-submodules fastapi \
  --collect-submodules starlette \
  --collect-submodules pydantic \
  --collect-submodules anyio \
  --hidden-import h11 \
  --hidden-import httptools \
  --hidden-import websockets \
  --hidden-import wsproto \
  --hidden-import watchfiles \
  --hidden-import PIL.Image \
  --hidden-import PIL.ImageDraw \
  --hidden-import PIL.ImageFont \
  --hidden-import PIL.ImageFilter \
  --exclude-module matplotlib \
  --exclude-module scipy \
  --exclude-module pandas \
  --exclude-module IPython \
  --exclude-module pytest \
  textphantom_launcher.py

ls -lh dist/TextPhantomLocalAPI
