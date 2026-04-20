"""Ensure required env vars exist before `app` (and SQLAlchemy engine) is imported."""

from __future__ import annotations

import os

# Tests must not require a live Postgres if unset (e.g. CI); override with DATABASE_URL for integration runs.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
# decode_access_token and similar use JWT secret at import/runtime
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-for-pytest-only")
