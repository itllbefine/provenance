---
name: Phase 1 complete — project scaffolding
description: Phase 1 of Provenance is built. Records the setup, key decisions, and how to run the app.
type: project
---

Phase 1 scaffolding is complete as of 2026-03-20.

**How to apply:** Use this as the baseline when starting Phase 2 (provenance tracking).

## Structure
- `backend/` — FastAPI + SQLite (aiosqlite), Python 3.12 venv at `backend/.venv`
- `frontend/` — React 18 + TypeScript + Vite + TipTap 2.x

## Running the app
Backend: `cd backend && .venv/bin/python3.12 -m uvicorn main:app --port 8000 --reload`
Frontend: `cd frontend && npm run dev`
Frontend dev server: http://localhost:5173
Backend API: http://localhost:8000

## Key decisions
- Backend uses a venv at `backend/.venv` (system Python is externally managed by brew)
- pip installs use `.venv/bin/pip` or `.venv/bin/python3.12 -m pip`
- Vite proxies `/api/*` to `http://localhost:8000` (strips the /api prefix)
- Documents stored as ProseMirror JSON strings in SQLite
- Author hardcoded as "local_user" for Phase 1
- Phase 1 has no provenance tracking yet — that's Phase 2
