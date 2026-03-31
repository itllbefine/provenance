# Frontend Project Documentation

## Overview

A React + TypeScript single-page application built with Vite. The editor is powered by TipTap (ProseMirror-based). All API calls go to `/api/*`, which Vite proxies to `http://localhost:8000`.

**Entry point:** `src/main.tsx` — mounts `<App>` in React StrictMode.

---

## Application Layout

```
App (state owner)
├── left-panel
│   ├── SuggestionsPanel  (top)
│   └── RationalePanel    (bottom)
└── right-panel
    └── EditorPanel
        ├── ProvenanceDebugPanel  (conditional)
        ├── YounessModal          (conditional)
        └── TimelineModal         (conditional)
```

---

## `src/api.ts`

Central HTTP client. All functions `throw` on non-2xx responses.

### Types

| Type | Description |
|---|---|
| `Document` | `{ id, title, content, context, created_at, updated_at }` |
| `ProvenanceEvent` | Stored event from the backend (has `id`, `document_id`) |
| `RawProvenanceEvent` | Event to be sent to the backend (no id yet); includes `origin`, `edit_type`, `pos_type` |
| `Suggestion` | `{ id, original_text, suggested_text, rationale, edit_type }` |
| `StyleSample` | `{ id, filename, uploaded_at, char_count }` |
| `YounessScore` | `{ score, explanation, human_pct, ai_pct, sample_count }` |
| `TimelineSpan` | `{ text, origin, edit_type }` |
| `TimelineMilestone` | `{ id, label, event_count, timestamp, spans }` |
| `TimelineResponse` | `{ milestones }` |
| `ChatMessage` | `{ role: 'user' | 'assistant', content }` |
| `SuggestedEdit` | `{ original_text, suggested_text, edit_type, rationale }` |
| `ChatResponse` | `{ message, suggested_edit: SuggestedEdit | null }` |
| `DismissedSuggestion` | `{ id, document_id, original_text, suggested_text, edit_type, rationale, dismissed_at }` |

### Functions

| Function | Method + Path | Description |
|---|---|---|
| `listDocuments()` | `GET /documents/` | Returns all documents |
| `createDocument(title?)` | `POST /documents/` | Creates a new document; default title `'Untitled'` |
| `saveDocument(id, title, content, context?)` | `PUT /documents/{id}` | Full update; `context` optional |
| `flushProvenanceEvents(docId, events)` | `POST /provenance/events` | Batch-sends buffered events; no-ops if empty |
| `getProvenanceEvents(docId)` | `GET /provenance/events/{docId}` | Returns all stored events |
| `generateSuggestions(docId, model?)` | `POST /suggestions/generate` | Triggers Claude suggestion generation; default model `claude-sonnet-4-6` |
| `chatWithContext(docId, contextText, messages, model?)` | `POST /suggestions/chat` | Conversational editor assistant |
| `uploadStyleSample(file)` | `POST /youness/samples` | Multipart upload of a `.txt` style sample |
| `listStyleSamples()` | `GET /youness/samples` | Returns all uploaded samples |
| `deleteStyleSample(id)` | `DELETE /youness/samples/{id}` | Removes a sample |
| `getYounessScore(docId)` | `GET /youness/score/{docId}` | Calls Claude Haiku to score document "you-ness" |
| `getHeatmapSpans(docId)` | `GET /timeline/{docId}/heatmap` | Returns provenance-tagged spans for the current document |
| `createManualSnapshot(docId)` | `POST /timeline/{docId}/snapshot` | Creates a named snapshot with current timestamp |
| `deleteSnapshot(snapshotId)` | `DELETE /timeline/snapshot/{snapshotId}` | Deletes a stored snapshot |
| `getTimeline(docId)` | `GET /timeline/{docId}` | Returns all stored snapshots + live "Current" |
| `listDismissed(docId)` | `GET /dismissed/{docId}` | Returns all dismissed suggestions for a document |
| `dismissSuggestion(docId, origText, sugText, editType, rationale)` | `POST /dismissed/` | Archives a dismissed suggestion |
| `restoreDismissed(dismissedId)` | `DELETE /dismissed/{dismissedId}` | Un-archives (restores) a dismissed suggestion |

---

## `src/App.tsx`

**Root component.** Owns all shared state and orchestrates communication between the editor and the suggestion panels.

### State

| State | Type | Description |
|---|---|---|
| `doc` | `Document \| null` | Currently active document |
| `allDocs` | `Document[]` | All documents, for the doc-picker dropdown |
| `saveStatus` | `SaveStatus` | `'saved' \| 'saving' \| 'unsaved' \| 'error'` |
| `suggestions` | `Suggestion[]` | Active (unacted) suggestions from the last generate call |
| `focusedIndex` | `number \| null` | Which suggestion card is focused (shows rationale in `RationalePanel`) |
| `isGenerating` | `boolean` | True while waiting for the `/generate` API call |
| `generateError` | `string \| null` | Error message shown below the Suggest button |
| `suggestionModel` | `'claude-sonnet-4-6' \| 'claude-opus-4-6'` | Which model to use for suggestions |
| `archive` | `DismissedSuggestion[]` | Persisted dismissed suggestions loaded from backend on doc switch |
| `activeSelection` | `string \| null` | Text currently selected in the editor; persists after blur |

### Refs

| Ref | Description |
|---|---|
| `applyEditRef` | Holds `EditorPanel`'s `applyEdit` function (registered on mount); called by `handleAccept` and chat accept |
| `flushEventsRef` | Holds `EditorPanel`'s `flushEvents` function; called before generating suggestions |
| `saveTimerRef` | Debounce handle for the 1.5s auto-save timer |
| `contextTimerRef` | Debounce handle for the 1s context auto-save timer |

### Key behaviors

- **Initial load:** Calls `listDocuments()` on mount; opens the first document or creates one if none exist.
- **Auto-save:** Content changes debounce 1.5s before calling `saveDocument`. Context changes debounce 1s separately.
- **Doc switch:** Cancels pending saves, resets all suggestion state, reloads `archive` from backend.
- **Suggestion deduplication:** After generation, filters `raw` results with `isDuplicate()` — compares `similarity()` (diff-match-patch Levenshtein) of both `original_text` and `suggested_text` against the archive; threshold is 80%. Observations are never filtered.
- **Accept:** Calls `applyEditRef.current(original, suggested, editType)`. Shows error if text not found.
- **Dismiss:** Calls `dismissSuggestion` API, adds to `archive`, removes from active list.
- **Restore:** Calls `restoreDismissed` API, removes from `archive`.

### Exports

- `SaveStatus` — string union type used by `EditorPanel` for the save indicator label.

---

## `src/components/EditorPanel.tsx`

**The rich text editor.** Hosts TipTap, manages provenance event capture and flushing, and provides tools for attribution, snapshots, and modal launches.

### Props

| Prop | Type | Description |
|---|---|---|
| `documentId` | `string` | ID of the currently open document |
| `initialTitle` | `string` | Document title on mount / doc switch |
| `initialContent` | `string` | Serialized ProseMirror JSON string |
| `initialContext` | `string` | Document context string |
| `allDocs` | `Document[]` | All documents for the doc-picker dropdown |
| `onNewDocument` | `() => void` | Called when the user clicks "+ New document" |
| `onSwitchDocument` | `(doc: Document) => void` | Called when the user picks a different doc |
| `onChange` | `(title, content) => void` | Called on every title or content change |
| `onContextChange` | `(context) => void` | Called on context textarea changes |
| `saveStatus` | `SaveStatus` | Shown in the toolbar |
| `onRegisterApplyEdit` | `(fn) => void` | Called once on mount with the `applyEdit` function |
| `onRegisterFlushEvents` | `(fn) => void` | Called once on mount with the `flushEvents` function |
| `onSelectionChange` | `(text \| null) => void` | Fired when editor selection changes (not on blur) |
| `getSuggestions` | `() => Suggestion[]` | Reads current suggestion list (for similarity retagging) |
| `archive` | `DismissedSuggestion[]` | Dismissed suggestion archive (for similarity retagging) |

### TipTap extensions used

- `StarterKit` — headings (H1–H3), bold, italic, bullet list, ordered list, blockquote, paragraph, hard break, etc.
- `ProvenanceExtension` — custom extension; watches transactions and emits provenance events.
- `AttributionExtension` — custom extension; renders provenance color decorations.
- `ProvenanceMark` — custom Mark extension; embeds provenance origin/timestamp directly in the document schema.

### Provenance event pipeline

1. `ProvenanceExtension.onEvent` pushes each `RawProvenanceEvent` into `pendingEventsRef`.
2. `flushEvents()` runs on a 2-second `setInterval` and on unmount.
3. Before flushing, `retagPendingHumanEvents()` runs a similarity check: accumulated human-typed text is compared against all visible suggestions and the archive. If similarity ≥ 80%, human events are re-tagged `ai_modified`; if 20–79%, they become `ai_influenced`.
4. On successful flush, if the Source view is active, `refreshAttributionDecos()` fetches fresh heatmap spans and rebuilds decorations.

### `applyEdit(original, suggested, editType, origin?)`

Registered with `App` via `onRegisterApplyEdit`. Called when a suggestion is accepted.

- **Net-new insert** (empty `original`): appends a new paragraph at the end.
- **Normal replace:** builds a flat `posMap` (char → ProseMirror position) by walking text nodes, inserting `\n\n` at paragraph boundaries. Finds `original` by exact string match first, then falls back to `diff-match-patch` fuzzy match (`threshold=0.4`).
- Dispatches a transaction tagged with `ai_suggestion` meta so `ProvenanceExtension` and `AttributionExtension` record the correct authorship.
- Returns `true` if the text was found and replaced, `false` otherwise.

### Source view (provenance heatmap)

The "Source" toolbar button toggles inline color decorations built from backend heatmap spans.

- On enable: flushes pending events, fetches `/timeline/{docId}/heatmap`, calls `buildDecorationsFromSpans`, dispatches `setAttributionDecos`.
- On disable: dispatches `clearAttributionDecos`.
- The legend below the toolbar shows four buckets (Human, AI Influenced, AI Assisted, AI Generated) with live percentages computed from `heatmapSpans`.

### Manual attribution

The "Attribute" button (enabled only when text is selected) emits a `retag` provenance event that changes the origin of the selected text range without modifying content.

### Toolbar buttons

`B`, `I`, `H1`–`H3`, `• —` (bullet list), `1 —` (ordered list), `"` (blockquote), `Source`, `Log`, `Score`, `Timeline`, `Snapshot`, `Context`, `Attribute` (disabled without selection).

Word count and save status are shown at the right of the toolbar.

### Modals launched

- `ProvenanceDebugPanel` — shown when "Log" is active
- `YounessModal` — shown when "Score" is clicked
- `TimelineModal` — shown when "Timeline" is clicked

---

## `src/components/SuggestionsPanel.tsx`

**Left-top panel.** Shows AI suggestions and the dismissed suggestion archive.

### Props

| Prop | Type | Description |
|---|---|---|
| `suggestions` | `Suggestion[]` | Active suggestions |
| `focusedIndex` | `number \| null` | Which card is highlighted |
| `isGenerating` | `boolean` | Shows "Thinking…" on the Suggest button |
| `generateError` | `string \| null` | Error banner below the header |
| `model` | `SuggestionModel` | Currently selected model |
| `onModelChange` | `(model) => void` | Sonnet / Opus toggle callback |
| `onGenerate` | `() => void` | Suggest button callback |
| `onFocus` | `(index) => void` | Card click callback |
| `onAccept` | `(index) => void` | Accept button callback |
| `onDismiss` | `(index) => void` | Dismiss button callback |
| `archive` | `DismissedSuggestion[]` | Dismissed suggestion list |
| `onRestore` | `(dismissedId) => void` | Restore button callback |

### Behavior

- Model toggle shows Sonnet / Opus buttons.
- `DiffView` renders a colored inline diff (del/ins) between `original_text` and `suggested_text` using `diff-match-patch`.
- `observation` edit type shows only `rationale` text; no Accept button and no diff.
- Archive tab shows dismissed suggestions with a Restore button; toggled by the "Archive (N)" button.
- `EDIT_TYPE_LABEL` maps `grammar_fix → 'Grammar'`, `wording_change → 'Wording'`, `organizational_move → 'Structure'`, `observation → 'Insight'`.

### Dependencies

`diff-match-patch`, `../api` (types only)

---

## `src/components/RationalePanel.tsx`

**Left-bottom panel.** Shows the rationale for the focused suggestion and a conversational chat interface for asking questions or requesting edits.

### Props

| Prop | Type | Description |
|---|---|---|
| `suggestion` | `Suggestion \| null` | Currently focused suggestion (shows rationale at top) |
| `documentId` | `string` | Used in the `chatWithContext` API call |
| `suggestionModel` | `'claude-sonnet-4-6' \| 'claude-opus-4-6'` | Model forwarded to the chat endpoint |
| `activeSelection` | `string \| null` | Persisted editor selection used as chat context |
| `onClearSelection` | `() => void` | Clears the selection preview after the user sends a message |
| `onAcceptChatEdit` | `(original, suggested, editType, origin) => boolean` | Called when the user accepts a chat-proposed edit |

### Behavior

- **Context priority:** If a suggestion is focused, its `original_text` is sent as `context_text`; otherwise the editor `activeSelection` is used.
- **Provenance origin for chat edits:**
  - Multi-turn (prior assistant messages exist): `ai_modified`
  - Had context (suggestion or selection): `ai_modified`
  - No context, first turn: `ai_generated`
- Conversation resets when `suggestion.id` changes.
- Enter sends (Shift+Enter inserts newline).
- Selection preview (up to 120 chars) shown when `activeSelection` is set and no suggestion is focused; has an ✕ to dismiss.
- `DiffView` (same diff-match-patch component as `SuggestionsPanel`) renders proposed edits; accepted edits remove the proposal from the message.

### Dependencies

`diff-match-patch`, `../api` (`chatWithContext`, `ChatMessage`, `SuggestedEdit`, `Suggestion`)

---

## `src/components/TimelineModal.tsx`

**Full-screen modal.** Displays all timeline snapshots as a horizontal grid of provenance-colored text cards, and exports them as PNG and PDF.

### Props

| Prop | Type | Description |
|---|---|---|
| `documentId` | `string` | Passed to `getTimeline` and `deleteSnapshot` |
| `onClose` | `() => void` | Closes the modal |

### Behavior

- Loads `getTimeline(documentId)` on mount.
- Displays each `TimelineMilestone` as a `MilestoneSnapshot` card: label, edit count, timestamp, and the full provenance-colored text body.
- Non-"Current" snapshots have a ✕ delete button (with `window.confirm`).
- The "Current" milestone always uses the live heatmap colors; past snapshots are visual references.
- `ColorKey` shows a legend of all four origin categories with optional percentages.
- Attribution percentages (`computeAttribPcts`) count non-whitespace characters per origin bucket, rounded to whole numbers summing to 100.

### Export (`exportTimeline`)

Dynamically imports `html2canvas` and `jspdf` (lazy-loaded to avoid bundle bloat). Produces three files on one button click:

1. **PNG (1080×1080):** Grid of snapshot thumbnail cards. Past snapshots are CSS-blurred (`blur(3px)`); "Current" is sharp. Cards are rendered off-screen with `html2canvas` (scale=2). Legend centered below the grid.
2. **PDF letter (8.5"×11"):** Real selectable text using `jsPDF`. Two-pass render: first layout positions, then background rects (merged into continuous same-color runs to avoid gaps), then text on top. Legend and attribution footer included.
3. **PDF square (1080×1080pt ≈ 810×810pt):** Same as the letter PDF but in a square format.

### Internal components

- `SpanText` — renders a `TimelineSpan` with background color; splits on `\n` and inserts `<br>`.
- `MilestoneSnapshot` — a single timeline card with header and colorized body text.
- `ColorKey` — legend row with swatches and optional percentage labels.

### Color mapping

| Origin(s) | Label | CSS color |
|---|---|---|
| `human`, `human_edit` | Human | transparent |
| `ai_influenced` | AI Influenced | `rgba(34, 211, 238, 0.55)` |
| `ai_modified`, `ai_collaborative` | AI Assisted | `rgba(74, 222, 128, 0.55)` |
| `ai_generated` | AI Generated | `rgba(251, 191, 36, 0.50)` |

### Dependencies

`../api` (`getTimeline`, `deleteSnapshot`, `TimelineMilestone`, `TimelineResponse`, `TimelineSpan`); `html2canvas` and `jspdf` (dynamic imports)

---

## `src/components/YounessModal.tsx`

**Modal overlay.** Manages uploading baseline writing samples and computing a "You-ness" score for the current document.

### Props

| Prop | Type | Description |
|---|---|---|
| `documentId` | `string` | Passed to `getYounessScore` |
| `onClose` | `() => void` | Closes the modal |

### Behavior

- Loads `listStyleSamples()` on mount.
- Hidden `<input type="file" accept=".txt">` triggered programmatically by the Upload button.
- Uploading or deleting a sample invalidates the current score (`setScore(null)`).
- "Compute score" calls `getYounessScore(documentId)` and displays the 0–100 score, explanation, and a human/AI percentage bar.
- Score button disabled when no samples are uploaded.

### Dependencies

`../api` (`uploadStyleSample`, `listStyleSamples`, `deleteStyleSample`, `getYounessScore`, `StyleSample`, `YounessScore`)

---

## `src/components/ProvenanceDebugPanel.tsx`

**Developer debug panel.** Shows the raw provenance event log fetched from the backend. Appears inside the editor panel when the "Log" toolbar button is active.

### Props

| Prop | Type | Description |
|---|---|---|
| `documentId` | `string` | Passed to `getProvenanceEvents` |

### Behavior

- Fetches `getProvenanceEvents(documentId)` on mount and when `documentId` changes.
- Shows each event as a row: type badge, position range, inserted text (green), deleted text (red), timestamp.
- Manual refresh button.

### Dependencies

`../api` (`getProvenanceEvents`, `ProvenanceEvent`)

---

## `src/provenance/ProvenanceExtension.ts`

**TipTap extension.** Watches every ProseMirror transaction and emits `RawProvenanceEvent` objects for text insertions, deletions, and replacements.

### Options

| Option | Type | Description |
|---|---|---|
| `onEvent` | `(event: RawProvenanceEvent) => void` | Called for each captured event; default is a no-op |

### How it works

1. `onTransaction` fires after every transaction that changes the document.
2. Transactions with `preventUpdate` meta (TipTap `setContent` on doc switch) are skipped.
3. For each `ReplaceStep` in the transaction, it:
   - Converts `step.from` / `step.to` from ProseMirror positions to plain-text indices using `pmToText` (calls `doc.textBetween(0, pos, '\n', '\n')`).
   - Extracts `deletedText` from the intermediate doc and `insertedText` from the step's slice.
   - Skips steps with no text change (both empty after conversion).
   - Sets `event_type` to `'insert'`, `'delete'`, or `'replace'`.
   - Sets `origin` from `ai_suggestion` meta if present; otherwise `'human_edit'` if there is deleted text, `'human'` for pure inserts.
4. Non-`ReplaceStep` steps (e.g. `ReplaceAroundStep`, `AddMarkStep`) advance the intermediate doc but do not emit events.
5. All emitted events have `pos_type: 'text'` (plain-text, structure-independent positions).

### Meta interface

`ai_suggestion` meta on a transaction: `{ edit_type: string, origin: 'ai_generated' | 'ai_modified', author: string }`. Set by `EditorPanel.applyEdit`.

### Key helper

`pmToText(doc, pmPos)` — clamps position and calls `doc.textBetween(0, clampedPos, '\n', '\n')` to produce a structure-independent character index. Both paragraph boundaries and `hardBreak` nodes produce `'\n'`.

### Dependencies

`@tiptap/core`, `@tiptap/pm/transform` (`ReplaceStep`), `../api` (`RawProvenanceEvent`)

---

## `src/provenance/AttributionExtension.ts`

**TipTap extension.** Renders inline color decorations over editor text based on provenance origin tags. Decorations are driven externally (from backend heatmap spans) and updated automatically as the document changes.

### Commands

| Command | Description |
|---|---|
| `setAttributionDecos(decorations)` | Replace the entire decoration set and enable the attribution view |
| `clearAttributionDecos()` | Remove all decorations and disable the view |

### Plugin state (`AttrState`)

- `enabled: boolean` — whether decorations are displayed.
- `decorations: DecorationSet` — current set of inline decorations.

State transitions:
- `{ clear: true }` meta → disabled, empty.
- `{ set: DecorationSet }` meta → enabled, new decorations.
- `preventUpdate` meta (doc switch) → keeps `enabled`, resets decorations to empty.
- Normal transactions → decorations mapped through `tr.mapping`; if `ai_suggestion` meta is present and the view is enabled, new inline decorations are added immediately for the inserted ranges.

### `buildDecorationsFromSpans(doc, spans)`

Builds a `DecorationSet` from backend `TimelineSpan[]`:

1. Flattens spans into a `(char, origin)` array, skipping `'\n'` and `'boundary'` spans.
2. Extracts plain text from PM doc text nodes.
3. If lengths match: direct 1:1 mapping. If they differ: uses `diff-match-patch` semantic diff to align span origins onto PM characters; unmatched PM characters default to `'human'`.
4. Walks PM text nodes, groups consecutive characters with the same origin into runs, and emits `Decoration.inline` for each non-human run.

### `originToClass(origin)`

Maps origin strings to CSS class strings:

| Origin | CSS classes |
|---|---|
| `'ai_influenced'` | `attr-span attr-span--influenced` |
| `'ai_modified'`, `'ai_collaborative'` | `attr-span attr-span--assisted` |
| `'ai_generated'` | `attr-span attr-span--generated` |
| `'human'`, `'human_edit'`, others | `''` (no decoration) |

### Exported symbols

- `AttributionExtension` — the TipTap extension
- `attributionKey` — `PluginKey` for accessing plugin state from outside
- `buildDecorationsFromSpans` — used by `EditorPanel` to build decos from heatmap API response
- `originToClass` — shared mapping; used by `EditorPanel` for the source legend

### Dependencies

`@tiptap/core`, `@tiptap/pm/state`, `@tiptap/pm/model`, `@tiptap/pm/view`, `@tiptap/pm/transform`, `diff-match-patch`, `../api` (`TimelineSpan`)

---

## `src/provenance/ProvenanceMark.ts`

**TipTap Mark extension.** Embeds provenance metadata directly in the ProseMirror document schema as a serializable mark. Unlike `AttributionExtension` (ephemeral decorations from backend heatmap spans), this mark persists in the document JSON across saves and reloads.

### Commands

| Command | Description |
|---|---|
| `setProvenance({ origin, timestamp })` | Apply the provenance mark to the current selection |
| `unsetProvenance()` | Remove the provenance mark from the current selection |

### Attributes

| Attribute | Type | Description |
|---|---|---|
| `origin` | `'human' \| 'ai_influenced' \| 'ai_assisted' \| 'ai_generated'` | Authorship classification |
| `timestamp` | ISO 8601 string | When the provenance was recorded |

### Rendered HTML

`<span data-provenance data-origin="..." data-timestamp="...">text</span>`

Parsed back from HTML via the `span[data-provenance]` selector, so it does not conflict with other `<span>` elements produced by `AttributionExtension` decorations.

### Notes

- `inclusive: false` — typing at the mark boundary does not extend the mark onto new characters.
- Extension name is `'provenanceMark'` (not `'provenance'`) to avoid collision with `ProvenanceExtension`.

### Dependencies

`@tiptap/core` (`Mark`, `mergeAttributes`)

---

## `src/provenance/classifier.ts`

**Rule-based human edit classifier.** Exported as a pure function; not currently invoked at runtime (the backend classification path is disabled, and human edits are stored without subtype). Kept for potential future use.

### `classifyHumanEdit(inserted, deleted)`

- **Input:** Both inserted and deleted strings from a replacement event.
- **Returns:** `'human_grammar_fix'` if stripping all non-word characters (Unicode `\p{L}\p{N}`) and lowercasing both sides gives equal strings (i.e., only punctuation/whitespace/capitalisation changed). Returns `null` for pure inserts, pure deletes, or ambiguous word-level changes.

### Exported type

`HumanEditType` — `'human_grammar_fix' | 'human_wording_change' | 'human_organizational_move'`

---

## External Dependencies

| Package | Used by | Purpose |
|---|---|---|
| `@tiptap/react` | `EditorPanel` | React wrapper for TipTap editor |
| `@tiptap/starter-kit` | `EditorPanel` | Standard ProseMirror node/mark types |
| `@tiptap/core` | Both extensions, `ProvenanceMark` | Extension/Mark API |
| `@tiptap/pm/transform` | Both extensions | `ReplaceStep` type |
| `@tiptap/pm/state` | `AttributionExtension` | `Plugin`, `PluginKey` |
| `@tiptap/pm/model` | `AttributionExtension` | `Node` type |
| `@tiptap/pm/view` | `AttributionExtension` | `Decoration`, `DecorationSet` |
| `diff-match-patch` | `App`, `EditorPanel`, `SuggestionsPanel`, `RationalePanel`, `AttributionExtension` | Similarity scoring, visual diffs, fuzzy text matching |
| `html2canvas` | `TimelineModal` | Rasterizes DOM cards for PNG export (lazy-loaded) |
| `jspdf` | `TimelineModal` | Generates PDF files with real selectable text (lazy-loaded) |
