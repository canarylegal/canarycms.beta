"""Sync Canary users to Radicale's htpasswd file (shared Docker volume)."""
from __future__ import annotations

import fcntl
import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import bcrypt

_HTPASSWD_PATH = Path(os.getenv("RADICALE_HTPASSWD_PATH", "/radicale-data/users"))


def htpasswd_path() -> Path:
    return _HTPASSWD_PATH


@contextmanager
def _htpasswd_lock(path: Path) -> Generator[None, None, None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with open(lock_path, "a+", encoding="utf-8") as lock_f:
        fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)


def _noncomment_lines(text: str) -> list[str]:
    return [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def upsert_user(*, username: str, plaintext_password: str) -> None:
    if not username.strip():
        raise ValueError("username required")
    path = htpasswd_path()
    digest = bcrypt.hashpw(plaintext_password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")
    entry = f"{username}:{digest}"
    with _htpasswd_lock(path):
        if path.is_file():
            lines = _noncomment_lines(path.read_text(encoding="utf-8"))
        else:
            lines = []
        out: list[str] = []
        seen = False
        for line in lines:
            u = line.split(":", 1)[0]
            if u == username:
                out.append(entry)
                seen = True
            else:
                out.append(line)
        if not seen:
            out.append(entry)
        path.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")


def remove_user(username: str) -> None:
    path = htpasswd_path()
    if not path.is_file():
        return
    with _htpasswd_lock(path):
        lines = _noncomment_lines(path.read_text(encoding="utf-8"))
        out = [line for line in lines if line.split(":", 1)[0] != username]
        if not out:
            path.unlink(missing_ok=True)
            return
        path.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
