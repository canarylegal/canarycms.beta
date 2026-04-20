"""Export matter head types, sub types, and sub menus to a seed JSON file."""
import json
import sys

from app.db import SessionLocal
from app.models import MatterHeadType, MatterSubType, MatterSubTypeMenu
from sqlalchemy import select

db = SessionLocal()

heads = db.execute(select(MatterHeadType).order_by(MatterHeadType.name)).scalars().all()
out = []
for h in heads:
    subs = db.execute(
        select(MatterSubType)
        .where(MatterSubType.head_type_id == h.id)
        .order_by(MatterSubType.name)
    ).scalars().all()
    sub_list = []
    for s in subs:
        menus = db.execute(
            select(MatterSubTypeMenu)
            .where(MatterSubTypeMenu.sub_type_id == s.id)
            .order_by(MatterSubTypeMenu.name)
        ).scalars().all()
        sub_list.append({
            "name": s.name,
            "prefix": s.prefix,
            "menus": [m.name for m in menus],
        })
    out.append({"name": h.name, "sub_types": sub_list})

db.close()

result = json.dumps({"version": 1, "matter_types": out}, indent=2)
print(result)
