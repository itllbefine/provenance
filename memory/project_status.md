---
name: Project status — all completed phases
description: Full current state of the Provenance app: all 7 phases plus collaborative chat. Architecture, all routes, all components, key decisions.
type: project
---

All 7 phases from PROMPT.md are complete, plus an additional collaborative chat feature. Last updated 2026-03-20.

## Tech stack

- **Backend**: FastAPI (Python 3.12), aiosqlite (SQLite), Anthropic SDK
- **Frontend**: React 18 + TypeScript + Vite, TipTap 2.x (ProseMirror wrapper), diff-match-patch
- **DB file**: `backend/provenance.db` (SQLite, auto-created on startup)
- **Dev**: Vite proxies `/api/*` → `http://localhost:8000` (strips `/api` prefix); CORS allows `localhost:5173`

## Running the app

Backend: `cd backend && .venv/bin/python3.12 -m uvicorn main:app --port 8000 --reload`
Frontend: `cd frontend && npm run dev`
Frontend: http://localhost:5173 / Backend: http://localhost:8000

## Database (SQLite via aiosqlite)

Migrations for new columns use `ALTER TABLE … ADD COLUMN` wrapped in try/except (idempotent).

| Table | Purpose |
|---|---|
| `documents` | id (UUID), title, content (ProseMirror JSON string), context (user-supplied purpose/tone), created_at, updated_at |
| `provenance_events` | append-only edit log: event_type, origin, edit_type, position, length, text_delta, author, timestamp, metadata (JSON) |
| `style_samples` | uploaded baseline writing samples for You-ness scoring |
| `text_snapshots` | periodic plain-text snapshots per document — used for timeline feature |
| `provenance_spans` | legacy spans table (not actively used by current routes) |

`origin` values: `'human' | 'ai_generated' | 'ai_modified' | 'ai_influenced' | 'ai_collaborative'`

Provenance tagging rule: tags only move toward more human involvement, never less. `ai_collaborative` is the most human-involved AI origin. Never overwrite a tag to imply less human involvement.

## Backend routes

### `documents.py` — `/documents`
- `GET /documents` — list all documents
- `POST /documents` — create new document
- `GET /documents/{id}` — get one document
- `PUT /documents/{id}` — update title/content/context. `context` is a free-text description of the document's purpose/tone, injected into the suggestions system prompt when non-empty.
- `POST /documents/{id}/provenance` — flush provenance events from frontend
- `GET /documents/{id}/provenance` — get provenance events (for debug panel)

### `suggestions.py` — `/suggestions`
- `POST /suggestions/generate` — calls Claude Sonnet with the document text and returns 3–5 structured editing suggestions. Accepts a `dismissed: list[str]` field; active dismissed entries (those still present verbatim in the document) are injected into the prompt so Claude avoids re-suggesting them, and Claude's output is post-filtered as a safety net. Uses tool_use for structured JSON output.
- `POST /suggestions/chat` — multi-turn chat with Claude, optionally proposes edits via `propose_edit` tool. `tool_choice: "auto"` so Claude can reply in plain text or propose an edit. Full conversation history sent each request (stateless backend).

Edit types: `grammar_fix`, `wording_change`, `organizational_move`.

### `youness.py` — `/youness` (also mounted at `/documents/{id}/youness` and `/documents/{id}/baseline`)
- `POST /youness/samples` — upload a plain-text baseline writing sample (stored up to 50k chars)
- `GET /youness/samples` — list samples
- `DELETE /youness/samples/{id}` — delete sample
- `GET /youness/score/{doc_id}` — calls Claude Haiku to compute a 0–100 stylometric similarity score comparing the document against uploaded baseline samples. Also returns human_pct/ai_pct computed from provenance events.

### `timeline.py` — `/timeline` (also mounted at `/documents/{id}/timeline`)
- `GET /timeline/{doc_id}` — returns text snapshots with diffs for the document timeline view. Uses periodic `text_snapshots` records rather than full event replay.

### `classify.py`
Classifies human edits into `human_grammar_fix`, `human_wording_change`, or `human_organizational_move`. Rule-based for simple cases; calls Claude Sonnet for ambiguous replacements.

## Frontend components

### `App.tsx`
Top-level state: current document, save status, suggestions list, dismissed suggestions, focused suggestion index, document context, model selector, `activeSelection` (persisted editor selection string or null). Debounced save (1.5s content/title, 1s context). Dismissed suggestions and `activeSelection` reset on document switch. Wires `applyEdit` ref and `onSelectionChange` to EditorPanel; passes `activeSelection` + `onClearSelection` to RationalePanel.

### `EditorPanel.tsx`
TipTap editor with toolbar (Bold, Italic, H1–H3, lists, blockquote, Heat, Log, Score, Timeline, Context). Collapsible context panel (textarea). Registers `applyEdit` callback via ref. Provenance events buffered in a ref and flushed to backend every 2s (and on unmount). `left-bottom` in App.css uses `overflow: hidden` so RationalePanel controls its own scroll.

Accepts `onSelectionChange?: (text: string | null) => void` — fires with selected text when the user makes a non-empty selection while the editor is focused, or `null` when they place the cursor without selecting. Does NOT fire on blur, so the stored selection survives focus moving to the chat input. (Replaced the old `onRegisterGetSelection` callback pattern.)

### `SuggestionsPanel.tsx`
Left top panel. Lists AI suggestions with diff view (diff-match-patch), Accept/Dismiss buttons, edit-type badges. Model selector (Sonnet/Opus). Generate button. Accept calls `applyEdit`; Dismiss adds `original_text` to the dismissed list.

### `RationalePanel.tsx`
Left bottom panel. Shows focused suggestion's rationale. Multi-turn chat thread with `LocalMessage[]` state. If Claude proposes an edit via the `propose_edit` tool, shows inline `DiffView` and Accept button (tagged `ai_collaborative`). Conversation resets when focused suggestion changes.

Accepts `activeSelection: string | null` (persisted editor selection from App state) and `onClearSelection` instead of the old `getSelectedText` callback. When `activeSelection` is set and no suggestion is focused, shows a quoted preview bar above the chat input (with a ✕ to dismiss). Context priority on send: `suggestion.original_text ?? activeSelection ?? ''`. Selection is cleared after each send.

### `ProvenanceDebugPanel.tsx`
Toggled by "Log" button. Shows raw provenance event log for the current document.

### `YounessModal.tsx`
Modal for you-ness score display (0–100, explanation, human/AI authorship %) + baseline sample management (upload, list, delete).

### `TimelineModal.tsx`
Modal showing document timeline with snapshots and diffs. Has a **color key bar** (between header and body) with two groups — Human and AI — each listing the four edit-type swatches. Has an **Export** button in the header that generates:
- 25%, 50%, 75% milestones → individual PNG files (`timeline-25pct.png`, etc.) with heatmap colors visible but text blurred (`filter: blur(4px)` on the body), showing authorship pattern without revealing content
- 100% milestone → `timeline-100pct.pdf` with full readable text

Uses `html2canvas` + `jspdf` (dynamically imported to avoid bundle bloat). Each export card is rendered off-screen at 2× scale for retina quality.

## TipTap extensions

### `ProvenanceExtension`
Intercepts every ProseMirror transaction. Skips transactions where both inserted and deleted text are empty (e.g. Enter key). Tags events with `origin` and `edit_type` from transaction meta. Calls `onEvent` callback with a `RawProvenanceEvent`.

### `HeatmapExtension`
Decorates text with CSS classes based on authorship. Toggle state stored in a ProseMirror plugin key (`heatmapKey`). Each decoration maps `(origin, edit_type)` to a class like `heatmap-span--human-grammar-fix`.

### `classifier.ts`
Frontend classifier that assigns `edit_type` to human edits before they're sent to the backend, providing an initial classification that the backend may override.

## Key design decisions

- ProseMirror positions include structural tokens (1 per char, 2 per `\n`); timeline replay uses a custom `_pm_to_text` walker to map PM positions to flat buffer indices
- Dismissed suggestions stored in frontend state keyed by `original_text`; auto-cleared by backend when original text no longer appears verbatim in the document
- Provenance events buffered in a ref and flushed every 2s — not per-keystroke — to avoid hammering the backend
- Document context is a free-text field per document describing purpose/tone/audience; injected into the suggestions system prompt when non-empty
- Conversation history is stateless on backend — full history sent with each chat request
- Context for chat captured at send time (not reactively) to avoid re-render churn
- Editor content stored as ProseMirror JSON string in SQLite
- Timeline uses periodic text snapshots (not full event replay)
