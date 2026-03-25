---
name: Project status — all completed phases
description: Full current state of the Provenance app: all 7 phases plus collaborative chat. Architecture, all routes, all components, key decisions.
type: project
---

All 7 phases from PROMPT.md are complete, plus an additional collaborative chat feature. Last updated 2026-03-24.

## App layout

Three-column flex layout (left to right):
1. **`.doc-list-panel`** (180px) — document list with "+ New" button; clicking a doc switches to it
2. **`.left-panel`** (340px) — SuggestionsPanel (top, flex 3) + RationalePanel (bottom, flex 2)
3. **`.right-panel`** (flex 1) — EditorPanel

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
| `text_snapshots` | periodic plain-text snapshots per document (legacy, unused) |
| `timeline_snapshots` | snapshots captured on Suggest clicks or manually — stores provenance-tagged spans as JSON, optional `label` column for custom names |
| `provenance_spans` | legacy spans table (not actively used by current routes) |
| `dismissed_suggestions` | archive of dismissed AI suggestions per document — id, document_id, original_text, suggested_text, edit_type, rationale, dismissed_at |

`origin` values: `'human' | 'human_edit' | 'ai_generated' | 'ai_modified' | 'ai_influenced' | 'ai_collaborative'`
- `'human'` = original first-draft typing (pure insert, nothing deleted) — no heatmap color
- `'human_edit'` = human replaced existing content (deletedText non-empty) — colored in heatmap

Provenance tagging rule: tags only move toward more human involvement, never less. `ai_collaborative` is the most human-involved AI origin. Never overwrite a tag to imply less human involvement.

## Backend routes

### `documents.py` — `/documents`
- `GET /documents` — list all documents
- `POST /documents` — create new document
- `GET /documents/{id}` — get one document
- `PUT /documents/{id}` — update title/content/context. `context` is a free-text description of the document's purpose/tone, injected into the suggestions system prompt when non-empty.
- `POST /documents/{id}/provenance` — flush provenance events from frontend
- `GET /documents/{id}/provenance` — get provenance events (for debug panel)

### `dismissed.py` — `/dismissed`
- `GET /dismissed/{document_id}` — list all archived dismissed suggestions for a document (newest first)
- `POST /dismissed/` — archive a dismissed suggestion (document_id, original_text, suggested_text, edit_type, rationale)
- `DELETE /dismissed/{dismissed_id}` — restore (un-dismiss) a suggestion by removing it from the archive

### `suggestions.py` — `/suggestions`
- `POST /suggestions/generate` — calls Claude with the document text and returns 3–6 structured editing suggestions. Dismissed-suggestion filtering is handled client-side via diff-match-patch similarity scoring (not sent to Claude). Uses tool_use for structured JSON output.
- `POST /suggestions/chat` — multi-turn chat with Claude, optionally proposes edits via `propose_edit` tool. `tool_choice: "auto"` so Claude can reply in plain text or propose an edit. Full conversation history sent each request (stateless backend).

Edit types: `grammar_fix`, `wording_change`, `organizational_move`.

### `youness.py` — `/youness` (also mounted at `/documents/{id}/youness` and `/documents/{id}/baseline`)
- `POST /youness/samples` — upload a plain-text baseline writing sample (stored up to 50k chars)
- `GET /youness/samples` — list samples
- `DELETE /youness/samples/{id}` — delete sample
- `GET /youness/score/{doc_id}` — calls Claude Haiku to compute a 0–100 stylometric similarity score comparing the document against uploaded baseline samples. Also returns human_pct/ai_pct computed from provenance events.

### `timeline.py` — `/timeline` (also mounted at `/documents/{id}/timeline`)
- `GET /timeline/{doc_id}/heatmap` — replays all provenance events and returns the final (100%) provenance-tagged spans for the live editor heatmap.
- `GET /timeline/{doc_id}` — returns stored snapshots (Suggest-click and manual, each with `id` field) plus a live "Current" snapshot (id=null) computed by replaying all events.
- `POST /timeline/{doc_id}/snapshot` — creates a manual snapshot labeled with the current timestamp (e.g. "Snapshot — Mar 21, 3:45 PM").
- `DELETE /timeline/snapshot/{snapshot_id}` — deletes a stored timeline snapshot by id.
- `create_snapshot(db, doc_id, label=None)` — helper called by `suggestions.py` (label=None → "Suggest N") or by the manual snapshot endpoint (with custom label). Replays provenance events, stores the result in `timeline_snapshots` table.


## Frontend components

### `App.tsx`
Top-level state: current document (`doc`), full document list (`allDocs`), save status, suggestions list, dismissed suggestions, focused suggestion index, document context, model selector, `activeSelection` (persisted editor selection string or null). Debounced save (1.5s content/title, 1s context). Dismissed suggestions and `activeSelection` reset on document switch. Wires `applyEdit` ref, `flushEvents` ref, and `onSelectionChange` to EditorPanel; passes `activeSelection` + `onClearSelection` to RationalePanel. `handleGenerate` flushes pending provenance events before calling `generateSuggestions`.

Document management: `handleNewDocument()` calls `createDocument()`, prepends to `allDocs`, and switches to the new doc. `handleSwitchDocument(doc)` cancels any pending save timer and switches to the selected doc. `handleChange` also updates the title in `allDocs` in real time so the list stays in sync.

### `EditorPanel.tsx`
TipTap editor with toolbar (Bold, Italic, H1–H3, lists, blockquote, **Source**, Log, Score, Timeline, Snapshot, Context, Attribution, word count). Collapsible context panel (textarea). Registers `applyEdit` and `flushEvents` callbacks via refs. Provenance events buffered in a ref and flushed to backend every 2s (and on unmount). Word count displayed in toolbar to the left of the save indicator. `left-bottom` in App.css uses `overflow: hidden` so RationalePanel controls its own scroll.

**Source toggle** (live attribution view): toggles origin-based provenance colors over editor text in real time. Uses `AttributionExtension` (ProseMirror plugin in `provenance/AttributionExtension.ts`) which stores a `DecorationSet` and maps it through transactions. On toggle-on: flushes pending events, fetches spans from `GET /timeline/{doc_id}/heatmap`, builds decorations via `buildDecorationsFromSpans()`. After each 2s flush cycle while active, re-fetches and rebuilds so retagging (e.g. ai_influenced detection) is reflected. AI suggestion acceptances are decorated immediately via transaction meta interception (no round-trip needed). Colors match the timeline view: Human=transparent, AI Influenced=cyan (0.20 alpha), AI Assisted=green (0.20), AI Generated=amber (0.22). CSS classes: `.attr-span--influenced`, `.attr-span--assisted`, `.attr-span--generated`. When Source is active, a **legend bar** appears below the toolbar showing labeled color swatches for all four categories (`.source-legend` in EditorPanel.css).

**Debounced AI-influence detection**: EditorPanel accumulates insertedText from human provenance events. 2 seconds after the user stops typing, `retagPendingHumanEvents()` compares the accumulated text against `suggested_text` from all visible suggestions AND the dismissed archive (passed as `archive` prop from App). Thresholds: ≥80% similarity → `ai_modified` (AI Assisted), 20–79% → `ai_influenced`, <20% → no change. Only runs when accumulated text is ≥10 characters. Also runs at the start of every `flushEvents()` call to catch events before they leave the client.

**Manual Snapshot button**: flushes pending provenance events then calls `POST /timeline/{doc_id}/snapshot` to capture a snapshot labeled with the current timestamp (e.g. "Snapshot — Mar 21, 3:45 PM").

**Manual Attribution button**: toolbar dropdown (enabled only when text is selected) that lets users override the provenance tag for selected text. Options (in order): Human, AI Influenced, AI Assisted, AI Generated. "AI Assisted" maps to `ai_modified` origin internally. Pushes a synthetic `replace` provenance event (same text as both inserted and deleted) to `pendingEventsRef` so the tag change is recorded without modifying document content.

Accepts `onSelectionChange?: (text: string | null) => void` — fires with selected text when the user makes a non-empty selection while the editor is focused, or `null` when they place the cursor without selecting. Does NOT fire on blur, so the stored selection survives focus moving to the chat input. (Replaced the old `onRegisterGetSelection` callback pattern.)

### `SuggestionsPanel.tsx`
Left top panel. Lists AI suggestions with diff view (diff-match-patch), Accept/Dismiss buttons, edit-type badges. Model selector (Sonnet/Opus). Generate button. Accept calls `applyEdit`; Dismiss persists the suggestion to the `dismissed_suggestions` DB table via the `/dismissed` API. Toggleable **Archive** view shows all previously dismissed suggestions with a **Restore** button that removes them from the archive. Archive is loaded from DB on document switch and persists across sessions. New suggestions from Claude are filtered client-side against the archive using diff-match-patch similarity scoring (>80% similarity on both original_text and suggested_text = suppressed).

### `RationalePanel.tsx`
Left bottom panel. Shows focused suggestion's rationale. Multi-turn chat thread with `LocalMessage[]` state. If Claude proposes an edit via the `propose_edit` tool, shows inline `DiffView` and Accept button. **Context-aware provenance tagging**: each assistant message stores `hadContext` (whether the user had a selection or focused suggestion when they sent the triggering message). At acceptance time, origin is computed: multi-turn refinement (prior assistant messages exist) → `ai_modified` (AI Assisted); had context (selection/suggestion) → `ai_modified`; no context, single turn → `ai_generated` (AI Generated). Accepting a chat edit clears the proposed edit from that message (mirrors SuggestionsPanel behavior); `onAcceptChatEdit` returns a boolean so the panel knows whether the edit applied. Conversation resets when focused suggestion changes.

**`applyEdit` net-new insertion support**: When `original_text` is empty, `applyEdit` appends `suggested_text` as a new paragraph at the end of the document instead of searching for text to replace. When an exact `original_text` match fails, falls back to diff-match-patch `match_main` fuzzy matching (threshold 0.4, distance 10000). The `CHAT_SYSTEM_PROMPT` instructs Claude to use `original_text: ""` for net-new content.

Accepts `activeSelection: string | null` (persisted editor selection from App state) and `onClearSelection` instead of the old `getSelectedText` callback. When `activeSelection` is set and no suggestion is focused, shows a quoted preview bar above the chat input (with a ✕ to dismiss). Context priority on send: `suggestion.original_text ?? activeSelection ?? ''`. Selection is cleared after each send.

### `ProvenanceDebugPanel.tsx`
Toggled by "Log" button. Shows raw provenance event log for the current document.

### `YounessModal.tsx`
Modal for you-ness score display (0–100, explanation, human/AI authorship %) + baseline sample management (upload, list, delete).

### `TimelineModal.tsx`
Modal showing document timeline with Suggest-click snapshots, manual snapshots, and live "Current" snapshot. Each non-Current snapshot has a **delete button (X)** with a confirmation dialog. Has a **color key bar** with four origin-based categories: Human (white/transparent), AI Influenced (cyan), AI Assisted (green, covers both `ai_modified` and `ai_collaborative`), AI Generated (amber). Has an **Export** button that generates:
- `timeline.png` — 1080×1080 PNG with all snapshots as a thumbnail grid, centered. Non-Current cards are blurred (3px radius). Legend centered at bottom, bold 12px font.
- `timeline-current.pdf` — letter-size (8.5"×11") PDF with real selectable text rendered via jsPDF (`times` font). Provenance highlight colors drawn as merged background rects. All sizes scale proportionally to page width.
- `timeline-current-square.pdf` — 1080×1080px (810pt) square PDF, same renderer with proportionally scaled fonts (~15pt body text).

PDF word wrapping builds a flat per-character color buffer from provenance spans first, then tokenizes into whole words (whitespace-only breaks) so words crossing span boundaries never split mid-word.

Uses `html2canvas` for PNG cards + `jspdf` for PDF (dynamically imported). `LEGEND_ITEMS` array keyed by `origins[]` (multiple origins per entry). `spanPdfBg()` blends RGB against white at 30% alpha for opaque PDF backgrounds.

## TipTap extensions

### `ProvenanceExtension`
Intercepts every ProseMirror transaction. Skips transactions where both inserted and deleted text are empty (e.g. Enter key). Tags events with `origin` and `edit_type` from transaction meta. Calls `onEvent` callback with a `RawProvenanceEvent`. Does NOT do AI-influence detection — that's handled by the debounced similarity check in EditorPanel.

### `AttributionExtension`
Live provenance coloring for the editor. Stores a `DecorationSet` in a ProseMirror plugin (`attributionKey`), maps it through transactions, and returns decorations from `props.decorations` when enabled. Commands: `setAttributionDecos(decos)` (enable + replace), `clearAttributionDecos()` (disable + clear). Immediately decorates AI suggestion acceptances via `ai_suggestion` transaction meta interception. Exports `buildDecorationsFromSpans(doc, spans)` which walks PM text nodes in lockstep with backend `TimelineSpan[]` to build a `DecorationSet`. Origin-based CSS classes: `.attr-span--influenced` (cyan), `.attr-span--assisted` (green), `.attr-span--generated` (amber).

### `classifier.ts`
Frontend classifier that assigns `edit_type` to human edits before they're sent to the backend, providing an initial classification that the backend may override.

## Key design decisions

- ProseMirror positions include structural tokens (1 per char, 2 per `\n`); timeline replay uses a custom `_pm_to_text` walker to map PM positions to flat buffer indices
- Dismissed suggestions persisted in `dismissed_suggestions` DB table per document; loaded on doc switch. New suggestions filtered client-side using diff-match-patch Levenshtein similarity (>80% on both original_text and suggested_text = suppressed). Dismissed list is NOT sent to Claude (saves tokens). Archive view in SuggestionsPanel shows all dismissed with Restore button.
- Provenance events buffered in a ref and flushed every 2s — not per-keystroke — to avoid hammering the backend
- Document context is a free-text field per document describing purpose/tone/audience; injected into the suggestions system prompt when non-empty
- Conversation history is stateless on backend — full history sent with each chat request
- Context for chat captured at send time (not reactively) to avoid re-render churn
- Editor content stored as ProseMirror JSON string in SQLite
- Timeline snapshots are triggered by Suggest clicks or manually via toolbar button. Frontend flushes pending provenance events before creating a snapshot. Manual snapshots get a timestamp label; Suggest snapshots get "Suggest N". Snapshots can be deleted from the timeline modal (except the live "Current" one).
- Human edits (`human`/`human_edit` origin) are NOT highlighted in the timeline (transparent) — only AI origins get colored spans
- Timeline/export colors are origin-based (not edit_type): Human=transparent, AI Influenced=cyan, AI Assisted=green (ai_modified + ai_collaborative), AI Generated=amber
- Suggestion parsing in `suggestions.py` handles Claude returning items as JSON strings or dicts (normalizes both)
- AI-influence detection is debounced (2s after typing stops), not per-keystroke, to avoid performance overhead. Checks against both visible suggestions and dismissed archive. Accumulated insertedText is compared via diff-match-patch Levenshtein similarity. Thresholds: ≥80% → ai_modified, 20–79% → ai_influenced, <20% → human. Minimum 10 chars to avoid false positives.
