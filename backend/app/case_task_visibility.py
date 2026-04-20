"""Who may see or act on a case task (private vs firm-visible)."""

from __future__ import annotations

import uuid

from sqlalchemy import and_, or_

from app.models import CaseTask


def case_task_visible_to_user(task: CaseTask, user_id: uuid.UUID) -> bool:
    """If not private, any case viewer may see it. If private, only creator or assignee."""
    if not task.is_private:
        return True
    if task.created_by_user_id == user_id:
        return True
    if task.assigned_to_user_id is not None and task.assigned_to_user_id == user_id:
        return True
    return False


def case_task_list_visibility_clause(user_id: uuid.UUID):
    """SQLAlchemy filter: tasks visible on a matter task list for this user."""
    return or_(
        CaseTask.is_private.is_(False),
        CaseTask.created_by_user_id == user_id,
        CaseTask.assigned_to_user_id == user_id,
    )


def case_task_ribbon_visibility_clause(user_id: uuid.UUID):
    """SQLAlchemy filter: tasks shown on the global ribbon (my tasks)."""
    return or_(
        CaseTask.assigned_to_user_id == user_id,
        and_(CaseTask.is_private.is_(True), CaseTask.created_by_user_id == user_id),
    )
