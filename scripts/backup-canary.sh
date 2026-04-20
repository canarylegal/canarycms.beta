#!/usr/bin/env bash
# Back up Canary PostgreSQL (db-data) and Radicale (radicale-data) for disaster recovery.
# Requires: docker compose, stack running (db + backend — backend mounts radicale-data at /radicale-data).
#
# Usage:
#   ./scripts/backup-canary.sh
#   ./scripts/backup-canary.sh -o /var/backups/canary
#   ./scripts/backup-canary.sh --include-files   # also archives host ./data/files (case documents)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/.env"
  set +a
fi

OUT="${ROOT}/backups"
INCLUDE_FILES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)
      OUT="${2:?}"
      shift 2
      ;;
    --include-files)
      INCLUDE_FILES=1
      shift
      ;;
    -h|--help)
      sed -n '1,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${OUT}/canary-${STAMP}"
mkdir -p "$DEST"

if ! docker compose ps db --status running --quiet 2>/dev/null | grep -q .; then
  echo "error: db service is not running (cd to repo root and: docker compose up -d db)" >&2
  exit 1
fi

if ! docker compose ps backend --status running --quiet 2>/dev/null | grep -q .; then
  echo "error: backend service is not running (needed to read radicale-data volume)" >&2
  exit 1
fi

PGU="${POSTGRES_USER:-canary}"
PGD="${POSTGRES_DB:-canary}"
echo "Backing up PostgreSQL → ${DEST}/postgres.sql.gz"
docker compose exec -T db pg_dump -U "$PGU" --no-owner --no-acl "$PGD" | gzip -9 > "${DEST}/postgres.sql.gz"

echo "Backing up radicale-data → ${DEST}/radicale-data.tar.gz"
docker compose exec -T backend tar czf - -C /radicale-data . > "${DEST}/radicale-data.tar.gz"

if [[ "$INCLUDE_FILES" -eq 1 ]]; then
  FILES_DIR="${ROOT}/data/files"
  if [[ -d "$FILES_DIR" ]]; then
    echo "Archiving ${FILES_DIR} → ${DEST}/files.tar.gz"
    tar czf "${DEST}/files.tar.gz" -C "$(dirname "$FILES_DIR")" "$(basename "$FILES_DIR")"
  else
    echo "warning: --include-files but ${FILES_DIR} not found; skipped" >&2
  fi
fi

{
  echo "canary-backup ${STAMP}"
  echo "created_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(hostname -f 2>/dev/null || hostname)"
  echo "repo: ${ROOT}"
  echo "compose_project: ${COMPOSE_PROJECT_NAME:-$(basename "$ROOT")}"
  echo "include_files: ${INCLUDE_FILES}"
  echo ""
  echo "Restore: see scripts/restore-canary.sh (test on a copy first)."
} > "${DEST}/README.txt"

echo "Done: ${DEST}"
ls -lh "$DEST"
