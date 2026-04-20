Bundled precedent library for fresh deployments
================================================

When the `precedent` table is empty and `manifest.json` contains at least one entry
in `precedents`, the backend imports categories + files under `bundle/` on startup
(`app/precedent_bootstrap.py`). An empty `precedents` array does nothing (safe default).

Export from a running stack (inherits DATABASE_URL and FILES_ROOT from the container):

  docker compose exec backend python scripts/export_precedent_seed.py

Commit `manifest.json` and `bundle/*` so the next `docker build` includes them.
Categories are matched on the new machine by **matter head type name** and **sub-type name**
(must match Admin matter types).

---

Wiping users (except admins), cases, case files, and contacts (destructive)

  docker compose exec -e I_CONFIRM_CANARY_WIPE=yes backend python scripts/wipe_except_admin.py

Precedent library rows and files are kept; precedent `file.owner_id` is reassigned to
the first admin user.
