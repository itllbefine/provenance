# Architecture Overview

The Provenance writing tool is a two-process application: a **Vite/React SPA** (frontend) and a **FastAPI server** (backend). They communicate over HTTP via a Vite dev proxy. All state is persisted in a single SQLite database.

---

## Frontend ↔ Backend Connection

In development, Vite proxies all requests matching `/api/*` to `http://localhost:8000`. The frontend `api.ts` uses the path prefix `/api` with no hardcoded host. In production (if deployed), a reverse proxy would serve the same role.

```
Browser (localhost:5173)
  └── fetch('/api/...')
        └── [Vite proxy]
              └── FastAPI (localhost:8000)
                    └── SQLite (backend/provenance.db)
                    └── Anthropic Claude API (external)
```

CORS is configured in `main.py` to allow only `http://localhost:5173`.

---

## Data Flow: Key Operations

### 1. Typing in the editor

```
User types
  → TipTap transaction dispatched
  → ProvenanceExtension.onTransaction fires
      → Converts PM positions to plain-text indices (pmToText)
      → Emits RawProvenanceEvent into pendingEventsRef
  → Every 2s: retagPendingHumanEvents() runs similarity check
      → Compares accumulated typed text vs. suggestions + archive
      → Re-tags events: human → ai_modified (≥80%) or ai_influenced (20-79%)
  → flushEvents() sends POST /provenance/events (batch)
      → Backend inserts rows into provenance_events
  → If Source view is active: GET /timeline/{docId}/heatmap
      → Backend replays all events into doc buffer, compresses to spans
      → AttributionExtension rebuilds ProseMirror decorations
```

### 2. Accepting a suggestion

```
User clicks Accept in SuggestionsPanel
  → App.handleAccept calls applyEditRef.current(original, suggested, editType)
      → EditorPanel.applyEdit:
          - Builds posMap (char index → PM position) by walking text nodes
          - Finds original text: exact match first, then diff-match-patch fuzzy
          - Dispatches transaction with ai_suggestion meta {edit_type, origin, author}
  → ProvenanceExtension sees transaction:
      - Reads ai_suggestion meta
      - Emits event with origin=ai_generated or ai_modified
  → AttributionExtension sees transaction:
      - If Source view enabled: immediately decorates inserted range with ai_suggestion meta origin
  → App.handleAccept calls dismissSuggestion API to archive the accepted suggestion
  → pendingEventsRef accumulates the event until next flush
```

### 3. Generating suggestions

```
User clicks Suggest button
  → App.handleGenerate:
      1. Calls flushEventsRef.current() — flushes all pending provenance events first
      2. Calls POST /suggestions/generate
  → Backend:
      1. Fetches document from documents table
      2. Calls create_snapshot() — replays all events, stores compressed spans to timeline_snapshots
      3. Calls Claude API (claude-sonnet-4-6 or claude-opus-4-6) with tool_choice="any"
      4. Returns list[SuggestionResponse]
  → App receives raw suggestions
  → App.isDuplicate() filters against dismissed archive using diff-match-patch Levenshtein ≥80%
  → Filtered suggestions set as state, rendered in SuggestionsPanel
```

### 4. Loading the timeline

```
User clicks Timeline
  → TimelineModal mounts, calls GET /timeline/{docId}
  → Backend:
      - Loads stored snapshots from timeline_snapshots (ordered by snapshot_number)
      - Replays all provenance_events live for the "Current" milestone
      - Returns TimelineResponse { milestones: [...] }
  → TimelineModal renders each milestone as a provenance-colored card
  → Export: html2canvas captures DOM cards (PNG), jsPDF renders text (PDF)
```

### 5. Document save

```
User edits title or content
  → EditorPanel.onChange fires → App.onChange receives (title, content)
  → App sets saveStatus='unsaved', resets 1.5s debounce timer
  → After 1.5s idle: PUT /documents/{id} with {title, content}
  → On success: saveStatus='saved'

Context textarea changes follow the same pattern with a 1s debounce.
```

### 6. You-ness scoring

```
User opens Score modal, clicks Compute
  → GET /youness/score/{docId}
  → Backend:
      1. Fetches document, calls extract_text() to get plain text
      2. Aggregates provenance_events: SUM(length(inserted_text)) by origin
      3. Loads up to 3 most recent style_samples (capped at 2,000 chars each)
      4. Calls claude-haiku-4-5-20251001 with tool_choice="any"
      5. Returns score (0–100), explanation, human_pct, ai_pct
  → YounessModal displays score bar and explanation
```

---

## Position Encoding

A recurring complexity throughout the codebase. Two position systems exist:

| System | Who uses it | How it works |
|---|---|---|
| `pos_type='pm'` (legacy) | Old events in the DB | ProseMirror positions; counts structural tokens. `pm_pos = 1 + text_chars + 2 * newlines`. |
| `pos_type='text'` (current) | All new events | Plain-text character indices; `pmToText()` converts via `doc.textBetween(0, pos, '\n', '\n')`. |

The backend timeline router handles both: `'text'` events use positions as direct buffer indices; `'pm'` events walk through `_pm_to_text()`.

---

## Document Content Format

Document content is stored as a **ProseMirror JSON string** in `documents.content`. The frontend passes it directly to TipTap's `setContent`. The backend never parses the ProseMirror JSON structure — it uses `extract_text()` (a recursive function in `suggestions.py`) to flatten it to plain text when needed for Claude prompts.

---

## Provenance Replay (Backend)

The backend never stores "the current document state" as a derived field. Instead, `timeline.py` always reconstructs the current provenance-tagged state by replaying the full `provenance_events` log from scratch:

```
provenance_events rows (ordered by timestamp ASC)
  → _apply_event() applied to each row
      → maintains _DocBuffer: list[(char, origin, edit_type)]
  → _compress() merges consecutive same-origin chars into spans
  → spans serialized as JSON into timeline_snapshots, or returned directly by heatmap endpoint
```

This means heatmap and timeline queries are O(n) in total event count. Performance is acceptable for single-user, document-scale use; would need caching for larger datasets.

---

## Claude API Usage

| Endpoint | Model | Max tokens | Tool use | Purpose |
|---|---|---|---|---|
| `POST /suggestions/generate` | Sonnet or Opus (user-selected) | 4096 | `record_suggestions` (forced) | Batch editing suggestions |
| `POST /suggestions/chat` | Sonnet or Opus (user-selected) | 2048 | `propose_edit` (optional) | Conversational editing assistant |
| `GET /youness/score/{docId}` | claude-haiku-4-5-20251001 | 512 | `record_youness_score` (forced) | Stylometric scoring |

All Claude calls use the Anthropic tool-use API for structured JSON output. The client (`anthropic.AsyncAnthropic`) is lazily initialized in each module and raises HTTP 503 if `ANTHROPIC_API_KEY` is unset.

---

## Known Issues and Gotchas

### Position drift (resolved)
Legacy events stored ProseMirror positions (`pos_type='pm'`). These encode document structure (each paragraph wrapper costs 2 extra tokens), causing drift when documents have lists, blockquotes, or headings. The fix was the `pos_type='text'` system. New events are unaffected; old events in the DB are handled by the legacy `_pm_to_text()` path in the backend and by the `pmToText()` helper in the frontend.

### Heatmap vs. editor text mismatch
`AttributionExtension` aligns backend span origins onto ProseMirror text nodes using `diff-match-patch` when lengths differ. This can produce minor misalignment if the diff algorithm makes unexpected choices — particularly with repeated text, whitespace-heavy content, or formatting-only edits.

### Provenance events are not deleted
The `provenance_events` table is append-only. There is no compaction, archival, or deletion of old events. For very long documents with many editing sessions, the replay step will become slow. There is currently no mitigation for this.

### Auto-save race with suggestion flush
`handleGenerate` calls `flushEventsRef` before generating, but auto-save and event flushing run on separate timers. If auto-save fires at the same time as generation, there is a window where the backend could receive the suggestion request before all pending events are persisted. The event flush in `handleGenerate` is a synchronous await that partially mitigates this, but auto-save's debounce is independent.

### React StrictMode double-invocation
The app mounts in React StrictMode (`main.tsx`). In development, StrictMode intentionally double-invokes effects and renders. The provenance event pipeline uses refs and intervals which are generally StrictMode-safe, but the `setInterval` flush and `useEffect` for `flushEventsRef` registration should be verified if unexpected duplicate events appear during development.

### `classifier.ts` is unused
`classifyHumanEdit` in `classifier.ts` is exported but not called anywhere at runtime. Human edit subtype classification was disabled; the function is kept for potential future use.

### `provenance_spans` table is unused
The `provenance_spans` table is created by `init_db()` but is not written to or read by any current route. It is a legacy artifact from an earlier design.

### Dismissed suggestion deduplication threshold
The 80% Levenshtein similarity threshold in `App.isDuplicate()` uses character-level comparison via `diff-match-patch`. For short suggestions (e.g., single-word grammar fixes), 80% is a very high bar and may allow near-duplicates to slip through.

---

## File Map

```
provenance/
├── backend/
│   ├── main.py              # FastAPI app, CORS, lifespan, router registration
│   ├── database.py          # SQLite connection, init_db(), get_db() dependency
│   ├── models.py            # All Pydantic request/response models
│   └── routers/
│       ├── documents.py     # CRUD for documents
│       ├── provenance.py    # Batch event insert + event fetch
│       ├── suggestions.py   # Claude suggestion generation + chat; extract_text()
│       ├── youness.py       # Style sample upload/delete/list + you-ness scoring
│       ├── timeline.py      # Provenance replay, snapshot creation, timeline + heatmap
│       └── dismissed.py     # Dismissed suggestion archive CRUD
├── frontend/
│   └── src/
│       ├── main.tsx         # Entry point (React StrictMode)
│       ├── App.tsx          # Root state, deduplication, accept/dismiss orchestration
│       ├── api.ts           # All HTTP calls, all TypeScript types
│       ├── components/
│       │   ├── EditorPanel.tsx       # TipTap editor, provenance pipeline, applyEdit
│       │   ├── SuggestionsPanel.tsx  # Suggestion cards, archive tab, DiffView
│       │   ├── RationalePanel.tsx    # Focused rationale + chat assistant
│       │   ├── TimelineModal.tsx     # Timeline viewer + PNG/PDF export
│       │   ├── YounessModal.tsx      # Style sample upload + you-ness scoring
│       │   └── ProvenanceDebugPanel.tsx  # Raw event log (dev tool)
│       └── provenance/
│           ├── ProvenanceExtension.ts   # TipTap extension: event capture
│           ├── AttributionExtension.ts  # TipTap extension: inline decorations
│           └── classifier.ts            # Human edit classifier (currently unused)
├── ARCHITECTURE.md  # This file
├── backend/PROJECT.md   # Full backend API, schema, router, model documentation
├── frontend/PROJECT.md  # Full frontend component, extension, utility documentation
└── CLAUDE.md
```
