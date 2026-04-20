import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.audit import log_event
from app.case_task_visibility import case_task_list_visibility_clause, case_task_visible_to_user
from app.db_errors import raise_if_missing_case_task_is_private
from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.models import CaseTask, CaseTaskStatus, MatterSubTypeStandardTask, User
from app.schemas import CaseTaskCreate, CaseTaskOut, CaseTaskUpdate

router = APIRouter(prefix="/cases/{case_id}/tasks", tags=["case-tasks"])


def _case_task_out(db: Session, task: CaseTask) -> CaseTaskOut:
    assign_name = None
    if task.assigned_to_user_id:
        u = db.get(User, task.assigned_to_user_id)
        assign_name = u.display_name if u else None
    base = CaseTaskOut.model_validate(task, from_attributes=True)
    return base.model_copy(update={"assigned_display_name": assign_name})


@router.post("", response_model=CaseTaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    case_id: uuid.UUID,
    payload: CaseTaskCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseTaskOut:
    case = require_case_access(case_id, user, db)
    std_id = payload.standard_task_id
    if std_id:
        st = db.get(MatterSubTypeStandardTask, std_id)
        if not st:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Standard task not found",
            )
        if st.is_system and st.matter_sub_type_id is None:
            # Global built-in (e.g. Follow up) — applies to every case.
            pass
        elif case.matter_sub_type_id is None or st.matter_sub_type_id != case.matter_sub_type_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Standard task does not apply to this matter type",
            )
        override = (payload.title or "").strip()
        title_final = override if override else st.title
    else:
        title_final = (payload.title or "").strip()

    if payload.assigned_to_user_id is not None:
        au = db.get(User, payload.assigned_to_user_id)
        if not au or not au.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid assignee")

    task = CaseTask(
        case_id=case_id,
        created_by_user_id=user.id,
        title=title_final,
        description=payload.description,
        due_at=payload.due_at,
        standard_task_id=std_id,
        assigned_to_user_id=payload.assigned_to_user_id,
        priority=payload.priority,
        is_private=bool(payload.is_private),
    )
    db.add(task)
    try:
        db.commit()
    except DBAPIError as e:
        db.rollback()
        raise_if_missing_case_task_is_private(e)
        raise
    db.refresh(task)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.task.create",
        entity_type="case_task",
        entity_id=str(task.id),
        meta={
            "case_id": str(case_id),
            "title": task.title,
            "due_at": task.due_at,
            "assigned_to": str(task.assigned_to_user_id),
            "is_private": task.is_private,
        },
    )
    return _case_task_out(db, task)


@router.get("", response_model=list[CaseTaskOut])
def list_tasks(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CaseTaskOut]:
    require_case_access(case_id, user, db)
    try:
        tasks = (
            db.execute(
                select(CaseTask)
                .where(CaseTask.case_id == case_id)
                .where(case_task_list_visibility_clause(user.id))
                .order_by(CaseTask.created_at.desc())
            )
            .scalars()
            .all()
        )
    except DBAPIError as e:
        raise_if_missing_case_task_is_private(e)
        raise
    return [_case_task_out(db, t) for t in tasks]


@router.patch("/{task_id}", response_model=CaseTaskOut)
def update_task(
    case_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: CaseTaskUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseTaskOut:
    require_case_access(case_id, user, db)
    try:
        task = db.get(CaseTask, task_id)
    except DBAPIError as e:
        raise_if_missing_case_task_is_private(e)
        raise
    if not task or task.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if not case_task_visible_to_user(task, user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    data = payload.model_dump(exclude_unset=True)
    if "is_private" in data and task.created_by_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the task creator can change privacy",
        )
    if "assigned_to_user_id" in data and data["assigned_to_user_id"] is not None:
        au = db.get(User, data["assigned_to_user_id"])
        if not au or not au.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid assignee")

    for k, v in data.items():
        setattr(task, k, v)
    if "status" in data and task.case_event_id and task.status != CaseTaskStatus.open:
        task.case_event_id = None
    task.updated_at = datetime.utcnow()

    db.add(task)
    try:
        db.commit()
    except DBAPIError as e:
        db.rollback()
        raise_if_missing_case_task_is_private(e)
        raise
    db.refresh(task)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.task.update",
        entity_type="case_task",
        entity_id=str(task.id),
        meta={"case_id": str(case_id), **data},
    )
    return _case_task_out(db, task)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    case_id: uuid.UUID,
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    try:
        task = db.get(CaseTask, task_id)
    except DBAPIError as e:
        raise_if_missing_case_task_is_private(e)
        raise
    if not task or task.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if not case_task_visible_to_user(task, user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    db.delete(task)
    try:
        db.commit()
    except DBAPIError as e:
        db.rollback()
        raise_if_missing_case_task_is_private(e)
        raise
    log_event(
        db,
        actor_user_id=user.id,
        action="case.task.delete",
        entity_type="case_task",
        entity_id=str(task_id),
        meta={"case_id": str(case_id)},
    )
    return None
