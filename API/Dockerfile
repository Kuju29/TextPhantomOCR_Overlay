FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend

ENV PORT=7860
EXPOSE 7860

CMD ["bash", "-lc", "uvicorn backend.server:app --host 0.0.0.0 --port ${PORT}"]
