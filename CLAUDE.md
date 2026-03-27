# CLAUDE.md

- Python 3.12 is at python3.12 (not python3, which points to system 3.9.6)
- I'm new to Python. Explain non-obvious patterns when you use them.
- Python is in a venv at backend/.venv — use backend/.venv/bin/pip or backend/.venv/bin/python3.12 -m pip to install packages
- The general outline for the project is in PROMPT.md, split into seven iterative phases
- Ask before making architectural decisions that aren't in PROMPT.md
- Before making changes to frontend code, read `frontend/PROJECT.md` to identify which files are relevant. Do not read source files you don't need.
- Before making changes to backend code, read `backend/PROJECT.md` to identify which files are relevant. Do not read source files you don't need.
- Before making any architectural decisions, read `ARCHITECTURE.md`.
- After finishing a task that changes the architecture, API, components, or database schema, update `backend/PROJECT.md`, `frontend/PROJECT.md`, and/or `ARCHITECTURE.md` as appropriate before finishing.
- Keep changes scoped to the minimum files necessary.
- Default to Sonnet. Do not suggest switching to Opus.
## Memory

There are two memory systems. Keep them separate — don't duplicate content between them.

### Project memory: `memory/` (in this repo)
The canonical record of project architecture, routes, components, and design decisions. Read `memory/MEMORY.md` at session start. After making code changes, update the relevant file in `memory/` to capture new capabilities, route changes, component changes, schema changes, and structural decisions.

### Auto-memory: `~/.claude/projects/.../memory/`
User profile and working-style feedback only (how to collaborate, skill level, preferences). No project architecture content — just point to `memory/project_status.md` for that. Update when the user gives feedback about how to approach work, or reveals new preferences or skills.
