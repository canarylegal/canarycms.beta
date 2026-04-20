"""Global Tasks menu: case tasks with case context.

Without ``case_id``: tasks **assigned to the current user** (ribbon / my tasks).
With ``case_id``: all non-cancelled tasks for that matter (requires case access), e.g. Tasks opened from a case.
"""

from __future__ import annotations

import uuid

from sqlalchemy import and_, delete, select
from sqlalchemy.orm import Session

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.exc import DBAPIError

from app.case_task_visibility import case_task_list_visibility_clause, case_task_ribbon_visibility_clause
from app.db_errors import raise_if_missing_case_task_is_private
from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.models import Case, CaseTask, CaseTaskStatus, MatterHeadType, MatterSubType, User
from app.schemas import TaskMenuRowOut

router = APIRouter(prefix="/tasks", tags=["tasks"])

_PRI = {"low": 0, "normal": 1, "high": 2}


@router.get("", response_model=list[TaskMenuRowOut])
def list_task_menu(
    case_id: uuid.UUID | None = Query(
        None,
        description="If set, return all tasks for this case (not assignee-filtered). Omit for tasks assigned to the current user.",
    ),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TaskMenuRowOut]:
    q = (
        select(CaseTask, Case)
        .join(Case, CaseTask.case_id == Case.id)
        .where(CaseTask.status != CaseTaskStatus.cancelled)
    )
    if case_id is not None:
        require_case_access(case_id, user, db)
        q = q.where(CaseTask.case_id == case_id).where(case_task_list_visibility_clause(user.id))
    else:
        q = q.where(case_task_ribbon_visibility_clause(user.id))

    try:
        rows = db.execute(q).all()
    except DBAPIError as e:
        raise_if_missing_case_task_is_private(e)
        raise
    if not rows:
        return []

    sub_ids = {c.matter_sub_type_id for _, c in rows if c.matter_sub_type_id}
    sub_map: dict = {}
    head_map: dict = {}
    if sub_ids:
        subs = db.execute(select(MatterSubType).where(MatterSubType.id.in_(sub_ids))).scalars().all()
        sub_map = {s.id: s for s in subs}
        head_ids = {s.head_type_id for s in subs}
        if head_ids:
            heads = db.execute(select(MatterHeadType).where(MatterHeadType.id.in_(head_ids))).scalars().all()
            head_map = {h.id: h for h in heads}

    assign_ids = {t.assigned_to_user_id for t, _ in rows if t.assigned_to_user_id}
    user_map: dict = {}
    if assign_ids:
        for u in db.execute(select(User).where(User.id.in_(assign_ids))).scalars():
            user_map[u.id] = u.display_name

    out: list[TaskMenuRowOut] = []
    for task, case in rows:
        sub_name = None
        head_name = None
        if case.matter_sub_type_id and case.matter_sub_type_id in sub_map:
            sub = sub_map[case.matter_sub_type_id]
            sub_name = sub.name
            h = head_map.get(sub.head_type_id)
            head_name = h.name if h else None
        label_parts = [x for x in (head_name, sub_name) if x]
        matter_label = " · ".join(label_parts) if label_parts else "—"
        dt = task.due_at or task.created_at
        assign = user_map.get(task.assigned_to_user_id) if task.assigned_to_user_id else None
        pr = task.priority if task.priority in _PRI else "normal"
        out.append(
            TaskMenuRowOut(
                id=task.id,
                case_id=case.id,
                case_number=case.case_number,
                client_name=case.client_name,
                matter_description=case.title,
                matter_type_label=matter_label,
                task_title=task.title,
                date=dt,
                assigned_display_name=assign,
                priority=pr,  # type: ignore[arg-type]
                status=task.status,
                is_private=bool(task.is_private),
            )
        )

    def sort_key(r: TaskMenuRowOut) -> tuple:
        p = r.priority if r.priority in _PRI else "normal"
        return (-_PRI[p], r.date, str(r.id))

    out.sort(key=sort_key)
    return out


@router.delete("/completed", status_code=status.HTTP_204_NO_CONTENT)
def clear_completed_tasks(
    case_id: uuid.UUID | None = Query(
        None,
        description="If set, delete completed tasks for this case only. Omit to delete completed tasks assigned to the current user.",
    ),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        if case_id is not None:
            require_case_access(case_id, user, db)
            db.execute(
                delete(CaseTask).where(
                    and_(
                        CaseTask.case_id == case_id,
                        CaseTask.status == CaseTaskStatus.done,
                        case_task_list_visibility_clause(user.id),
                    )
                )
            )
        else:
            db.execute(
                delete(CaseTask).where(
                    and_(
                        CaseTask.status == CaseTaskStatus.done,
                        case_task_ribbon_visibility_clause(user.id),
                    )
                )
            )
        db.commit()
    except DBAPIError as e:
        raise_if_missing_case_task_is_private(e)
        raise
    return None
