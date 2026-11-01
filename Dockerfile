# QE Studio container: backend + built web UI in one image.
#
#   docker build -t qe-studio .
#   docker run --rm -p 127.0.0.1:8765:8765 -v qes-data:/data qe-studio
#
# Quantum ESPRESSO itself is not baked in: install it from the UI (Connections & QE ->
# conda-forge), upload your own binaries, or run on SSH/Kaggle connections. Everything the
# app stores (database, pseudopotentials, results, installed QE) lives in the /data volume.

# ---------------------------------------------------------------- frontend build
FROM node:22-bookworm-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    QES_HOME=/data \
    QES_NO_KEYRING=1 \
    QES_CONTAINER=1
# bash + procps: the job runner and process checks; curl/bzip2: the in-app QE installer
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash procps curl bzip2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/ /app/backend/
RUN pip install /app/backend
COPY --from=ui /src/frontend/dist /usr/local/share/qe-studio/ui
ENV QES_STATIC_DIR=/usr/local/share/qe-studio/ui
RUN useradd --create-home --uid 1000 qes && mkdir -p /data && chown qes:qes /data
USER qes
VOLUME ["/data"]
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/api/health').status==200 else 1)"
# 0.0.0.0 inside the container only; publish the port on 127.0.0.1 of the host (see compose file)
CMD ["qe-studio", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
