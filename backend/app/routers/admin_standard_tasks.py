"""Admin: standard task titles per matter sub-type."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.models import MatterSubType, MatterSubTypeStandardTask, User
from app.schemas import MatterSubTypeStandardTaskCreate, MatterSubTypeStandardTaskOut, MatterSubTypeStandardTaskUpdate

router = APIRouter(prefix="/admin/standard-tasks", tags=["admin-standard-tasks"])


@router.get("/by-sub-type/{sub_type_id}", response_model=list[MatterSubTypeStandardTaskOut])
def list_standard_tasks(
    sub_type_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[MatterSubTypeStandardTaskOut]:
    if not db.get(MatterSubType, sub_type_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter sub-type not found")
    global_rows = (
        db.execute(
            select(MatterSubTypeStandardTask).where(
                MatterSubTypeStandardTask.is_system.is_(True),
                MatterSubTypeStandardTask.matter_sub_type_id.is_(None),
            )
        )
        .scalars()
        .all()
    )
    local_rows = (
        db.execute(
            select(MatterSubTypeStandardTask)
            .where(MatterSubTypeStandardTask.matter_sub_type_id == sub_type_id)
            .where(MatterSubTypeStandardTask.is_system.is_(False))
            .order_by(MatterSubTypeStandardTask.sort_order, MatterSubTypeStandardTask.created_at)
        )
        .scalars()
        .all()
    )
    merged = list(global_rows) + list(local_rows)
    merged.sort(key=lambda r: (r.sort_order, r.created_at))
    return [MatterSubTypeStandardTaskOut.model_validate(r, from_attributes=True) for r in merged]


@router.post("", response_model=MatterSubTypeStandardTaskOut, status_code=status.HTTP_201_CREATED)
def create_standard_task(
    payload: MatterSubTypeStandardTaskCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeStandardTaskOut:
    if not db.get(MatterSubType, payload.matter_sub_type_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter sub-type not found")
    row = MatterSubTypeStandardTask(
        matter_sub_type_id=payload.matter_sub_type_id,
        title=payload.title.strip(),
        sort_order=payload.sort_order,
        is_system=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return MatterSubTypeStandardTaskOut.model_validate(row, from_attributes=True)


@router.patch("/{task_id}", response_model=MatterSubTypeStandardTaskOut)
def update_standard_task(
    task_id: uuid.UUID,
    payload: MatterSubTypeStandardTaskUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeStandardTaskOut:
    row = db.get(MatterSubTypeStandardTask, task_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Standard task not found")
    if row.is_system:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Built-in standard tasks cannot be edited",
        )
    data = payload.model_dump(exclude_unset=True)
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    for k, v in data.items():
        setattr(row, k, v)
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return MatterSubTypeStandardTaskOut.model_validate(row, from_attributes=True)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_standard_task(
    task_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(MatterSubTypeStandardTask, task_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Standard task not found")
    if row.is_system:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Built-in standard tasks cannot be deleted",
        )
    db.delete(row)
    db.commit()
    return None
