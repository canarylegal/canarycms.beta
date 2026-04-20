#!/bin/sh
set -e

# Build DATABASE_URL from POSTGRES_* when DATABASE_URL is not provided.
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_PASSWORD:-}" ] || [ -z "${POSTGRES_DB:-}" ]; then
    echo "DATABASE_URL is unset and required POSTGRES_* variables are missing." >&2
    exit 1
  fi

  POSTGRES_HOST="${POSTGRES_HOST:-db}"
  POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  ENCODED_PASSWORD="$(python -c "import os, urllib.parse; print(urllib.parse.quote(os.environ['POSTGRES_PASSWORD'], safe=''))")"
  export DATABASE_URL="postgresql+psycopg://${POSTGRES_USER}:${ENCODED_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
fi

exec "$@"
