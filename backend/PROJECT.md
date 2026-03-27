# Backend Project Documentation

FastAPI server for the Provenance writing tool. Serves a REST API consumed by the Vite/React frontend. Database is SQLite (`provenance.db`) managed via `aiosqlite`. External service: Anthropic Claude API (key in `backend/.env`).

**Entry point:** `main.py`
**Run with:** `uvicorn main:app --reload` (from `backend/`)
**Base URL prefix for all routes:** `/api/*` (Vite proxies this in dev)

---

## Application Setup (`main.py`)

- Loads `backend/.env` via `python-dotenv` at startup to populate `ANTHROPIC_API_KEY`.
- CORS is enabled for `http://localhost:5173` (Vite dev server).
- Database is initialized at startup via the FastAPI `lifespan` handler (`init_db()`).
- Routers registered: `dismissed`, `documents`, `provenance`, `suggestions`, `youness`, `timeline`.

**Health check:**
```
GET /health → {"status": "ok"}
```

---

## Database (`database.py`)

SQLite file at `backend/provenance.db`.

`get_db()` is a FastAPI dependency that opens a connection per request with `db.row_factory = aiosqlite.Row` (enables column-by-name access) and closes it when the request finishes.

`init_db()` runs at startup: creates all tables with `CREATE TABLE IF NOT EXISTS`, then runs `ALTER TABLE ADD COLUMN` migrations for columns added after initial schema. Migrations are wrapped in try/except so they're idempotent (SQLite raises `OperationalError` if a column already exists).

### Full Database Schema

#### `documents`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT NOT NULL | Default: `'Untitled'` |
| `content` | TEXT NOT NULL | ProseMirror JSON tree serialized to string. Default: `'{}'` |
| `context` | TEXT NOT NULL | Author-supplied notes on purpose/tone. Added via migration. Default: `''` |
| `created_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |

#### `provenance_events`
Append-only event log. Each row is one raw edit captured from a ProseMirror transaction.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `document_id` | TEXT NOT NULL | FK → `documents.id` |
| `event_type` | TEXT NOT NULL | `'insert'` \| `'delete'` \| `'replace'` \| `'retag'` |
| `from_pos` | INTEGER NOT NULL | Start position (see `pos_type`) |
| `to_pos` | INTEGER NOT NULL | End position (see `pos_type`) |
| `inserted_text` | TEXT NOT NULL | Text inserted at this position. Default: `''` |
| `deleted_text` | TEXT NOT NULL | Text that was removed. Default: `''` |
| `author` | TEXT NOT NULL | `'local_user'` or AI model name |
| `timestamp` | TEXT NOT NULL | ISO 8601 UTC |
| `origin` | TEXT NOT NULL | `'human'` \| `'human_edit'` \| `'ai_generated'` \| `'ai_modified'` \| `'ai_influenced'` \| `'ai_collaborative'`. Added via migration. Default: `'human'` |
| `edit_type` | TEXT | `'grammar_fix'` \| `'wording_change'` \| `'organizational_move'` \| null. Added via migration. |
| `pos_type` | TEXT NOT NULL | `'pm'` (legacy ProseMirror positions) \| `'text'` (plain-text char indices, structure-independent). Added via migration. Default: `'pm'` |

#### `provenance_spans`
Legacy table (created at init but not actively used by current routes). Each row is one contiguous run of text sharing authorship.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `document_id` | TEXT NOT NULL | FK → `documents.id` |
| `text` | TEXT NOT NULL | The text content |
| `origin` | TEXT NOT NULL | Authorship origin |
| `author` | TEXT NOT NULL | |
| `timestamp` | TEXT NOT NULL | ISO 8601 |
| `edit_type` | TEXT NOT NULL | |
| `parent_span_id` | TEXT | Self-referential FK (nullable) |
| `ai_model` | TEXT | Model that generated this span (nullable) |
| `confidence` | REAL NOT NULL | Default: `1.0` |
| `history` | TEXT NOT NULL | JSON array. Default: `'[]'` |

#### `style_samples`
Baseline writing samples uploaded by the user for you-ness scoring.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `text` | TEXT NOT NULL | File content, capped at 50,000 chars |
| `filename` | TEXT NOT NULL | Original filename |
| `uploaded_at` | TEXT NOT NULL | ISO 8601 UTC |

#### `timeline_snapshots`
Provenance-tagged document states captured at each "Suggest" click or manual snapshot.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `document_id` | TEXT NOT NULL | FK → `documents.id` |
| `snapshot_number` | INTEGER NOT NULL | Auto-incrementing per document |
| `event_count` | INTEGER NOT NULL | Number of provenance events at time of snapshot |
| `timestamp` | TEXT NOT NULL | ISO 8601 UTC |
| `spans` | TEXT NOT NULL | JSON array of `{text, origin, edit_type}` objects. Default: `'[]'` |
| `label` | TEXT | Display label (`'Suggest N'`, `'Snapshot — …'`). Added via migration. |

#### `dismissed_suggestions`
Archive of suggestions the user has dismissed, preventing re-display.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `document_id` | TEXT NOT NULL | FK → `documents.id` |
| `original_text` | TEXT NOT NULL | The original text the suggestion targeted |
| `suggested_text` | TEXT NOT NULL | The proposed replacement |
| `edit_type` | TEXT NOT NULL | `'grammar_fix'` \| `'wording_change'` \| `'organizational_move'` |
| `rationale` | TEXT NOT NULL | Claude's explanation. Default: `''` |
| `dismissed_at` | TEXT NOT NULL | ISO 8601 UTC |

---

## Models (`models.py`)

Pydantic models used for request validation and response serialization.

### Document Models
- **`DocumentCreate`** — request body for `POST /documents/`. Fields: `title` (default `'Untitled'`), `content` (default `'{}'`), `context` (default `''`).
- **`DocumentUpdate`** — request body for `PUT /documents/{id}`. All fields optional: `title`, `content`, `context`.
- **`DocumentResponse`** — response shape: `id`, `title`, `content`, `context`, `created_at`, `updated_at`.

### Provenance Models
- **`ProvenanceEventCreate`** — one event in a batch. Fields: `event_type`, `from_pos`, `to_pos`, `inserted_text`, `deleted_text`, `author`, `timestamp`, `origin` (default `'human'`), `edit_type` (optional), `pos_type` (default `'pm'`).
- **`ProvenanceBatchCreate`** — request body for `POST /provenance/events`. Fields: `document_id`, `events: list[ProvenanceEventCreate]`.
- **`ProvenanceEventResponse`** — response shape: adds `id` and `document_id` to event fields.

### You-ness Models
- **`StyleSampleResponse`** — `id`, `filename`, `uploaded_at`, `char_count`.
- **`YounessScoreResponse`** — `score` (0–100 int), `explanation` (string), `human_pct` (float), `ai_pct` (float), `sample_count` (int).

### Timeline Models
- **`TimelineSpan`** — `text`, `origin`, `edit_type` (optional).
- **`TimelineMilestone`** — `id` (optional, null for live "Current"), `label`, `event_count`, `timestamp`, `spans: list[TimelineSpan]`.
- **`TimelineResponse`** — `milestones: list[TimelineMilestone]`.

### Suggestion Models
- **`ALLOWED_SUGGESTION_MODELS`** — set constant: `{"claude-sonnet-4-6", "claude-opus-4-6"}`.
- **`SuggestionRequest`** — `document_id`, `model` (default `'claude-sonnet-4-6'`).
- **`SuggestionResponse`** — `id` (stringified index), `original_text`, `suggested_text`, `rationale`, `edit_type`.

### Chat Models
- **`ChatMessage`** — `role` (`'user'` | `'assistant'`), `content`.
- **`SuggestedEdit`** — `original_text`, `suggested_text`, `edit_type`, `rationale`.
- **`ChatRequest`** — `document_id`, `context_text` (optional), `messages: list[ChatMessage]`, `model`.
- **`ChatResponse`** — `message` (string), `suggested_edit` (optional `SuggestedEdit`).

### Dismissed Suggestion Models
- **`DismissedSuggestionCreate`** — `document_id`, `original_text`, `suggested_text`, `edit_type`, `rationale`.
- **`DismissedSuggestionResponse`** — adds `id`, `dismissed_at`.

---

## Routers

### Documents (`routers/documents.py`) — prefix `/documents`

#### `GET /documents/`
List all documents, newest first.
**Returns:** `list[DocumentResponse]`
**Query:** `SELECT * FROM documents ORDER BY updated_at DESC`

#### `POST /documents/`
Create a new document.
**Body:** `DocumentCreate` (title, content, context — all optional with defaults)
**Returns:** `DocumentResponse` (201)
**Side effects:** Inserts into `documents`.

#### `GET /documents/{doc_id}`
Fetch a single document by ID.
**Returns:** `DocumentResponse` or 404.

#### `PUT /documents/{doc_id}`
Update a document. Only provided fields are updated; `updated_at` is always refreshed.
**Body:** `DocumentUpdate` (all fields optional)
**Returns:** `DocumentResponse` or 404.
**Implementation note:** Builds a dynamic `SET` clause from whichever fields are non-None to avoid N×M query variants.

---

### Provenance (`routers/provenance.py`) — prefix `/provenance`

#### `POST /provenance/events`
Batch-insert provenance events for a document.
**Body:** `ProvenanceBatchCreate` — `{ document_id, events: [...] }`
**Returns:** `list[ProvenanceEventResponse]` (201)
**Side effects:** Inserts one row per event into `provenance_events`.
**Note:** All events in the batch are inserted in a single DB transaction for efficiency. Each event gets a new UUID `id`.

#### `GET /provenance/events/{doc_id}`
Return all provenance events for a document, oldest first.
**Returns:** `list[ProvenanceEventResponse]` or 404 if document doesn't exist.
**Query:** `SELECT * FROM provenance_events WHERE document_id = ? ORDER BY timestamp ASC`

---

### Suggestions (`routers/suggestions.py`) — prefix `/suggestions`

Calls the Anthropic API. Client is lazily initialized; missing API key raises 503 at call time.

#### Helper: `extract_text(node: dict) → str`
Recursively converts a ProseMirror JSON node tree to plain text. Block elements (`paragraph`, `heading`, `blockquote`, `listItem`, `codeBlock`) are separated by `\n\n`. `hardBreak` nodes become `\n`. Used by both `generate` and `chat` endpoints, and imported by `youness.py`.

#### `POST /suggestions/generate`
Generate editing suggestions for a document via Claude.
**Body:** `SuggestionRequest` — `{ document_id, model }`
**Returns:** `list[SuggestionResponse]` or 404/422/503.
**Validation:** Document must exist; text must be ≥50 chars; model must be in `ALLOWED_SUGGESTION_MODELS`.
**External service:** Claude API (`claude-sonnet-4-6` or `claude-opus-4-6`), `max_tokens=4096`, `tool_choice="any"`.
**Claude tool:** `record_suggestions` — forces structured output with fields `original_text`, `suggested_text`, `rationale`, `edit_type` (`grammar_fix` | `wording_change` | `organizational_move` | `observation`). Returns 3–6 items.
**Side effects:**
1. Calls `create_snapshot(db, doc_id)` from the timeline router *before* generating suggestions (captures the pre-suggestion state).
2. Suggestions with `edit_type="observation"` have empty `original_text` and `suggested_text`.

**System prompt behavior:** Base `SYSTEM_PROMPT` is extended with the document's `context` field if present. The user message is `"Title: {title}\n\n{document_text}"`.

#### `POST /suggestions/chat`
Conversational editing assistant.
**Body:** `ChatRequest` — `{ document_id, context_text, messages, model }`
**Returns:** `ChatResponse` — `{ message, suggested_edit | null }`.
**External service:** Claude API, `max_tokens=2048`, `tool_choice="auto"` (Claude may or may not call the tool).
**Claude tool:** `propose_edit` — optional structured edit with `original_text`, `suggested_text`, `edit_type`, `rationale`, and `message` (conversational reply). If Claude calls the tool, `message` comes from `tool.input.message`. If Claude replies in plain text, `suggested_edit` is null.
**System prompt includes:** Base `CHAT_SYSTEM_PROMPT` + optional `doc_context` + full document text + optional focused `context_text` (selected text or focused suggestion).
**Note:** To append new text (not replace existing), Claude sets `original_text=""`.

---

### You-ness Scoring (`routers/youness.py`) — prefix `/youness`

Calls the Anthropic API. Client is lazily initialized (returns `None` if key absent, raises 503 at score time).

#### `POST /youness/samples`
Upload a plain-text baseline writing sample (multipart form data).
**Body:** `file: UploadFile` — read as UTF-8 (invalid bytes replaced with `?`), capped at 50,000 chars.
**Returns:** `StyleSampleResponse` (201) or 422 if file is empty.
**Side effects:** Inserts into `style_samples`.

#### `GET /youness/samples`
List all uploaded baseline samples, newest first.
**Returns:** `list[StyleSampleResponse]`.
**Note:** Uses SQLite's `length(text)` function to compute `char_count` without fetching the full text column.

#### `DELETE /youness/samples/{sample_id}`
Delete a baseline writing sample.
**Returns:** 204 or 404.

#### `GET /youness/score/{doc_id}`
Compute the you-ness score for a document.
**Returns:** `YounessScoreResponse` or 404/422/503.

**Four-step process:**
1. **Load document** — fetch content, run `extract_text()` to get plain text; 422 if empty.
2. **Provenance breakdown** — aggregate `SUM(length(inserted_text))` grouped by `origin` from `provenance_events`. Computes `human_pct` and `ai_pct`. Only `'human'` counts as human; `'ai_generated'` and `'ai_modified'` count as AI. Other origins are ignored from the tally. If no events exist, assumes 100% human.
3. **Load samples** — fetch up to 3 most recent samples from `style_samples`, each capped at 2,000 chars for the prompt.
4. **Claude scoring** — calls `claude-haiku-4-5-20251001` (fast/cheap), `max_tokens=512`, `tool_choice="any"`. Tool `record_youness_score` returns `score` (0–100 int) and `explanation` (2–3 sentences naming specific stylistic features).

**If no samples uploaded:** Returns immediately with `score=0`, a prompt-to-upload message, the provenance breakdown, and `sample_count=0`. Does not call Claude.

---

### Timeline (`routers/timeline.py`) — prefix `/timeline`

Handles provenance replay and snapshot management. Snapshots are created automatically on each "Suggest" click and optionally by the user manually.

#### Internal: Position Replay

The replay system maintains a `_DocBuffer` — a `list[tuple[str, str, str | None]]` where each tuple is `(character, origin, edit_type)`. Paragraph boundaries are represented as `'\n'` characters.

**`pos_type` handling:**
- `'text'` events (new): `from_pos` / `to_pos` are direct buffer indices. Buffer is padded with `'\n'` if `from_pos > len(doc)`.
- `'pm'` events (legacy): positions use ProseMirror's encoding (`pm_pos = 1 + text_chars + 2 * newlines`). Converted via `_pm_to_text()` which walks the buffer. Buffer is padded if `from_pm > _pm_end(doc)`.

**Event types applied by `_apply_event()`:**
- `'retag'`: Change `origin` and `edit_type` in place for chars `[from_text, to_text)`, no text modification.
- `'insert'` / `'delete'` / `'replace'`: `del doc[from_text:to_text]` then insert new chars with their origin/edit_type.

**`_compress(doc: _DocBuffer) → list[dict]`:** Merges consecutive chars with the same `(origin, edit_type)` into spans: `{text, origin, edit_type}`.

#### Internal: `create_snapshot(db, doc_id, label=None)`
Called from `suggestions.py` before generating suggestions (`label=None` → auto-label `'Suggest N'`) or from the manual snapshot endpoint (`label` provided).

**Steps:**
1. `_replay_events()` — load all `provenance_events` for the doc ordered by `timestamp ASC`, apply each via `_apply_event()`, return `(doc_buffer, events)`.
2. If no events, return early (nothing to snapshot).
3. Compress buffer to spans, determine next `snapshot_number`, insert into `timeline_snapshots`.

#### `GET /timeline/{doc_id}/heatmap`
Return provenance-tagged spans for the current document state (replays all events live).
**Returns:** `list[TimelineSpan]` or 404. Empty list if no events.

#### `GET /timeline/{doc_id}`
Return all stored snapshots plus a live "Current" snapshot.
**Returns:** `TimelineResponse` — `{ milestones: [...] }` or 404.
**Stored snapshots:** Loaded from `timeline_snapshots` ordered by `snapshot_number ASC`. Display label is `row['label']` if present, else `'Suggest {snapshot_number}'`.
**Live "Current" snapshot:** Replayed from all events, appended at the end of milestones. `id` is `null`.

#### `POST /timeline/{doc_id}/snapshot`
Create a manual timeline snapshot.
**Returns:** `{"ok": True}` (201) or 404.
**Label format:** `"Snapshot — {Mon D, H:MM AM/PM}"` (e.g. `"Snapshot — Mar 26, 2:34 PM"`).
**Calls:** `create_snapshot(db, doc_id, label=label)`.

#### `DELETE /timeline/snapshot/{snapshot_id}`
Delete a stored snapshot.
**Returns:** `{"ok": True}` (200) or 404.

---

### Dismissed Suggestions (`routers/dismissed.py`) — prefix `/dismissed`

#### `GET /dismissed/{document_id}`
List all dismissed suggestions for a document, newest first.
**Returns:** `list[DismissedSuggestionResponse]`.

#### `POST /dismissed/`
Archive a dismissed suggestion.
**Body:** `DismissedSuggestionCreate` — `{ document_id, original_text, suggested_text, edit_type, rationale }`
**Returns:** `DismissedSuggestionResponse`.
**Side effects:** Inserts into `dismissed_suggestions`.

#### `DELETE /dismissed/{dismissed_id}`
Restore a dismissed suggestion (remove from archive so it may appear again).
**Returns:** `{"ok": True}`.
**Note:** No 404 — silently succeeds if the ID doesn't exist.

---

## External Services

| Service | Used by | Model(s) | Purpose |
|---|---|---|---|
| Anthropic Claude API | `suggestions.py` | `claude-sonnet-4-6`, `claude-opus-4-6` | Editing suggestions and chat |
| Anthropic Claude API | `youness.py` | `claude-haiku-4-5-20251001` | Stylometric scoring |

**API key:** `ANTHROPIC_API_KEY` env var, loaded from `backend/.env` at startup.
**Client:** `anthropic.AsyncAnthropic`, lazily initialized per module. Missing key raises HTTP 503 at call time (not at startup).
**Technique:** Both modules use the Anthropic tool-use API (`tool_choice`) rather than free-text prompts to guarantee structured JSON output.

---

## Key Design Decisions

- **Append-only event log:** `provenance_events` is never updated or deleted; it's the authoritative source of truth. The current document state is always reconstructed by replaying events.
- **Dual position types:** `pos_type='pm'` supports legacy events that stored ProseMirror positions (which encode document structure). `pos_type='text'` is used by the current frontend and stores plain-text character indices (structure-independent), avoiding drift from structural operations like list wrapping.
- **Snapshot-on-suggest:** A timeline snapshot is captured immediately before each AI suggestion generation, so the timeline shows what the document looked like when Claude was asked for help.
- **No session state:** All state is in SQLite. The API is fully stateless between requests.
- **Lazy Anthropic client:** The client singleton is only created when first needed, so the server starts successfully even without an API key configured.
