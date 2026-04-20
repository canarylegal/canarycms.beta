"""Lightweight API smoke tests (no database fixtures)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_auth_me_requires_bearer() -> None:
    client = TestClient(app)
    res = client.get("/auth/me")
    assert res.status_code == 401


def test_auth_me_rejects_bad_bearer() -> None:
    client = TestClient(app)
    res = client.get("/auth/me", headers={"Authorization": "Bearer not-a-real-jwt"})
    assert res.status_code == 401
