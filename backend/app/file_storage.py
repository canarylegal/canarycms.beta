from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


FILES_ROOT = Path(_require_env("FILES_ROOT")).resolve()


@dataclass(frozen=True)
class StoredFilePaths:
    abs_path: Path
    rel_path: str
    folder_path: str


def ensure_files_root() -> None:
    FILES_ROOT.mkdir(parents=True, exist_ok=True)


def _sanitize_folder_path(folder_path: str) -> str:
    # Accept user-provided folder path as a slash-separated relative string.
    # We do not allow absolute paths, backtracking (..), or traversal components.
    p = PurePosixPath(folder_path or "")
    parts: list[str] = []
    for part in p.parts:
        if part in ("", ".", "/"):
            continue
        if part == "..":
            raise ValueError("Invalid folder path")
        parts.append(part)
    return "/".join(parts)


def sanitize_folder_path(folder_path: str) -> str:
    # Public wrapper used by routers.
    return _sanitize_folder_path(folder_path)


def precedent_file_paths(*, precedent_id: uuid.UUID, file_id: uuid.UUID, original_filename: str) -> StoredFilePaths:
    safe_name = Path(original_filename).name
    rel = Path("precedents") / str(precedent_id) / f"{file_id}__{safe_name}"
    abs_path = (FILES_ROOT / rel).resolve()
    if not str(abs_path).startswith(str(FILES_ROOT)):
        raise RuntimeError("Resolved path escaped FILES_ROOT")
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    return StoredFilePaths(abs_path=abs_path, rel_path=str(rel), folder_path="")


def case_file_paths(*, case_id: uuid.UUID, file_id: uuid.UUID, original_filename: str, folder_path: str = "") -> StoredFilePaths:
    # Keep user-provided filename only as a suffix; never trust it as a path.
    safe_name = Path(original_filename).name

    sanitized_folder = _sanitize_folder_path(folder_path)
    base = Path("cases") / str(case_id)
    if sanitized_folder:
        rel = base / Path(sanitized_folder) / f"{file_id}__{safe_name}"
    else:
        rel = base / f"{file_id}__{safe_name}"
    abs_path = (FILES_ROOT / rel).resolve()
    if not str(abs_path).startswith(str(FILES_ROOT)):
        raise RuntimeError("Resolved path escaped FILES_ROOT")
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    return StoredFilePaths(abs_path=abs_path, rel_path=str(rel), folder_path=sanitized_folder)

