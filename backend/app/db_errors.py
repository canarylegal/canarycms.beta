"""Map common database errors to clearer API responses."""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.exc import DBAPIError


def raise_if_missing_case_task_is_private(exc: Exception) -> None:
    """
    After adding ``case_task.is_private``, old databases 500 on any task query.
    Turn that into a readable error so operators run ``alembic upgrade head``.
    """
    if not isinstance(exc, DBAPIError):
        return
    orig = getattr(exc, "orig", None)
    msg = str(orig or exc).lower()
    if "is_private" not in msg:
        return
    if (
        "does not exist" in msg
        or "no such column" in msg
        or "undefined column" in msg
        or "undefinedcolumn" in msg
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Database schema is out of date: apply migrations with `alembic upgrade head` "
                "in the Canary backend (adds case_task.is_private for private tasks)."
            ),
        ) from exc
