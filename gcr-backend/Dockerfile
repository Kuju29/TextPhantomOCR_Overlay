FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium chromium-driver fonts-liberation libgbm1 libnss3 libgconf-2-4 && \
    rm -rf /var/lib/apt/lists/*

ENV CHROME_BINARY=/usr/bin/chromium
ENV CHROME_EXTRA_ARGS="--no-sandbox --disable-dev-shm-usage --disable-gpu --window-size=1920,1080 --headless=new"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app
WORKDIR /app
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "--bind", "0.0.0.0:8080", "app.main:app"]
