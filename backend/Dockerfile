FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Headless LibreOffice for server-side .docx/.xlsx → .pdf conversion (no per-seat licence).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Includes docker-entrypoint.sh (required — do not gitignore)
COPY . /app

# Bundled precedent templates (manifest.json + bundle/*) — populate with scripts/export_precedent_seed.py
COPY precedents_seed /app/precedents_seed

RUN chmod +x /app/app/docker-entrypoint.sh

ENTRYPOINT ["/app/app/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
