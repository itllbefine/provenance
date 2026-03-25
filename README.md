# Provenance

A writing tool that tracks the authorship of every piece of text in a document — who wrote it, whether it was human or AI, what kind of edit it was, and how the document evolved over time.

## What it does

- **Provenance tracking** — every insert, delete, and replace is logged with origin and edit type. Text is classified as human-written, AI-generated, AI-assisted, or AI-influenced.
- **AI suggestions** — generates 3–6 structured editing suggestions (grammar fixes, wording changes, organizational moves) with rationale. Accept or dismiss with one click.
- **Collaborative chat** — multi-turn chat with Claude that can propose inline edits. Context-aware: references selected text or focused suggestions.
- **Source view** — toggle live color highlighting over the editor showing each span's provenance origin. Color key: Human (none), AI Influenced (cyan), AI Assisted (green), AI Generated (amber).
- **Timeline** — snapshots captured at each "Suggest" click or manually. Exportable as PNG (thumbnail grid) or PDF (full document with highlighted text).
- **You-ness score** — stylometric similarity score (0–100) comparing the document against uploaded baseline writing samples.
- **Document context** — per-document free-text field describing purpose, tone, and audience, injected into the AI system prompt.

## Tech stack

- **Backend**: FastAPI (Python 3.12), aiosqlite (SQLite), Anthropic SDK
- **Frontend**: React 18 + TypeScript + Vite, TipTap 2.x (ProseMirror), diff-match-patch
- **Database**: SQLite (`backend/provenance.db`, auto-created on first run)

## Setup

### Prerequisites

- Python 3.12
- Node.js 18+
- An Anthropic API key

### Backend

```bash
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=your_key_here
```

Start the server:

```bash
.venv/bin/python3.12 -m uvicorn main:app --port 8000 --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The frontend proxies `/api/*` to the backend at port 8000.

## Project structure

```
backend/
  main.py              # FastAPI app entry point
  routes/
    documents.py       # Document CRUD and provenance event flush
    suggestions.py     # AI suggestion generation and chat
    timeline.py        # Snapshots, heatmap replay, export
    youness.py         # You-ness scoring and baseline samples
    dismissed.py       # Dismissed suggestion archive
  provenance.db        # SQLite database (gitignored)

frontend/src/
  App.tsx              # Top-level state, document management
  api.ts               # Typed API client
  components/
    EditorPanel.tsx    # TipTap editor, toolbar, source view
    SuggestionsPanel.tsx
    RationalePanel.tsx # Chat + rationale display
    TimelineModal.tsx  # Timeline view and export
    YounessModal.tsx   # You-ness score and baseline management
  provenance/
    ProvenanceExtension.ts   # ProseMirror plugin — intercepts all transactions
    AttributionExtension.ts  # Live provenance color decorations
    classifier.ts            # Frontend edit-type classifier
```

## Provenance origin values

| Origin | Meaning |
|---|---|
| `human` | Original typing — no prior content replaced |
| `human_edit` | Human replaced existing content |
| `ai_generated` | Accepted AI suggestion with no user context |
| `ai_modified` | Accepted AI suggestion with selection/suggestion context, or multi-turn chat refinement |
| `ai_influenced` | Human typed text with 20–79% similarity to an AI suggestion |
| `ai_collaborative` | Chat edit accepted after multi-turn conversation |

Tags only move toward more human involvement, never less.
