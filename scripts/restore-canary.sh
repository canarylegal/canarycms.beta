#!/usr/bin/env bash
# Restore Canary from a folder produced by backup-canary.sh.
# DESTRUCTIVE: overwrites DB content and radicale-data. Stop clients first.
#
# Usage:
#   ./scripts/restore-canary.sh ./backups/canary-20260331-120000
#
# Optional:
#   ./scripts/restore-canary.sh ./backups/canary-... --skip-db
#   ./scripts/restore-canary.sh ./backups/canary-... --skip-radicale
#   ./scripts/restore-canary.sh ./backups/canary-... --files-only

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/.env"
  set +a
fi

SKIP_DB=0
SKIP_RADICALE=0
FILES_ONLY=0

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup-directory> [--skip-db] [--skip-radicale] [--files-only]" >&2
  exit 2
fi

BACKUP="${1:?}"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-db) SKIP_DB=1; shift ;;
    --skip-radicale) SKIP_RADICALE=1; shift ;;
    --files-only) SKIP_DB=1; SKIP_RADICALE=1; shift ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

[[ -d "$BACKUP" ]] || { echo "error: not a directory: $BACKUP" >&2; exit 1; }

if [[ "$SKIP_DB" -eq 0 ]] || [[ "$SKIP_RADICALE" -eq 0 ]]; then
  if ! docker compose ps db --status running --quiet 2>/dev/null | grep -q .; then
    echo "error: db must be running" >&2
    exit 1
  fi
fi

if [[ "$SKIP_RADICALE" -eq 0 ]]; then
  if ! docker compose ps backend --status running --quiet 2>/dev/null | grep -q .; then
    echo "error: backend must be running to restore radicale-data" >&2
    exit 1
  fi
fi

echo "WARNING: This will overwrite production data from:"
echo "  $BACKUP"
read -r -p "Type RESTORE to continue: " ok
[[ "$ok" == "RESTORE" ]] || { echo "aborted."; exit 1; }

PGU="${POSTGRES_USER:-canary}"
PGD="${POSTGRES_DB:-canary}"

if [[ "$SKIP_DB" -eq 0 ]]; then
  SQLGZ="${BACKUP}/postgres.sql.gz"
  [[ -f "$SQLGZ" ]] || { echo "error: missing $SQLGZ" >&2; exit 1; }
  echo "Restoring PostgreSQL (drops public schema, then loads dump)…"
  docker compose exec -T db psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1 <<SQL
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO $PGU;
GRANT ALL ON SCHEMA public TO public;
SQL
  gunzip -c "$SQLGZ" | docker compose exec -T db psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1
  echo "PostgreSQL restore finished."
fi

if [[ "$SKIP_RADICALE" -eq 0 ]]; then
  TGZ="${BACKUP}/radicale-data.tar.gz"
  [[ -f "$TGZ" ]] || { echo "error: missing $TGZ" >&2; exit 1; }
  echo "Stopping radicale (if running)…"
  docker compose stop radicale 2>/dev/null || true
  echo "Wiping and restoring /radicale-data in backend container…"
  docker compose exec -T backend find /radicale-data -mindepth 1 -delete
  docker compose exec -T backend tar xzf - -C /radicale-data < "$TGZ"
  echo "Radicale data restore finished. Start with: docker compose start radicale"
fi

FILES_TGZ="${BACKUP}/files.tar.gz"
if [[ -f "$FILES_TGZ" ]]; then
  echo "Restoring data/files from archive…"
  mkdir -p "${ROOT}/data"
  tar xzf "$FILES_TGZ" -C "${ROOT}/data"
  echo "files restore finished."
fi

echo "Restore complete. Run: docker compose up -d"
echo "Then: docker compose exec backend alembic upgrade head   # if DB was older than code"
