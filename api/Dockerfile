FROM python:3.11-slim

WORKDIR /app

# Runtime libraries plus the packages required by Hugging Face Spaces Dev Mode.
# Dev Mode injects SSH/VS Code/git setup layers on top of this image, so these
# tools must already exist in the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libgl1 \
       libglib2.0-0 \
       bash \
       curl \
       wget \
       procps \
       git \
       git-lfs \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend

# Hugging Face Docker Spaces Dev Mode requires /app to be writable by uid 1000.
# Create a real home directory as well because the injected Dev Mode layer runs
# `git config --global` as this user. Runtime state such as /app/logs and
# /app/state can still be created normally because /app belongs to uid 1000.
RUN useradd -m -u 1000 -s /bin/bash user \
  && chown -R 1000:1000 /app
ENV HOME=/home/user
USER 1000

ENV PORT=7860
EXPOSE 7860

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860", "--no-access-log", "--log-level", "warning", "--ws-ping-interval", "45", "--ws-ping-timeout", "45"]
