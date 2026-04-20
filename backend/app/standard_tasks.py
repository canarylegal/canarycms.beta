"""Built-in standard task definitions (rows also seeded in the database)."""

from __future__ import annotations

import uuid

# Fixed PK for the global "Follow up" template (`matter_sub_type_id` IS NULL).
CANARY_FOLLOW_UP_STANDARD_TASK_ID = uuid.UUID("a0000001-0000-4000-8000-000000000001")
