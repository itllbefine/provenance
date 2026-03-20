# Project: Authorship Provenance Writing Tool (Working Title: "Provenance")

## Overview

Build a web-based collaborative writing tool that tracks the provenance of every piece of text in a document — who wrote it, who edited it, what kind of edit it was, and whether it was human or AI. The tool produces a visual "heatmap" of the final document showing the blend of human and AI authorship, plus a "you-ness" score assessing how much the document sounds like the author.

This is a greenfield project. We are building from scratch using libraries, not forking an existing editor.

## Architecture

### Tech Stack
- **Frontend:** React + TipTap (ProseMirror-based rich text editor) + TypeScript
- **Backend:** Python + FastAPI
- **Provenance Layer:** Custom TipTap/ProseMirror plugin that intercepts all editor transactions and logs them with metadata
- **Edit Classification:** Rule-based for obvious cases (punctuation, capitalization), Claude API for ambiguous cases (wording vs. organizational changes)
- **Heatmap Rendering:** Custom ProseMirror decoration plugin mapping provenance metadata to background colors
- **Suggestion Display:** diff-match-patch for computing visual diffs shown in the suggestion panel
- **Storage:** SQLite for provenance logs; documents stored as ProseMirror JSON
- **Future-proofing:** Yjs integration point for real-time multi-author collaboration (don't implement yet, but don't make architectural choices that prevent it)

### UI Layout

The interface is a two-panel layout:

**Right panel:** A rich text editor (TipTap) where the user writes. This is the primary workspace. Standard rich text formatting (bold, italic, headers, lists, etc.). Clean and minimal — this should feel like a focused writing tool, not a cluttered IDE.

**Left panel (split top/bottom):**
- **Top:** Suggested edits view. Shows AI-proposed changes as an inline diff (strikethroughs for deletions, highlights for insertions — like Track Changes in Word). This panel can be "locked" to scroll in sync with the right panel, so the suggestion context stays aligned with the corresponding text in the editor. Each suggested edit chunk can be accepted with a single click or keyboard shortcut (e.g., Tab to accept, Esc to dismiss).
- **Bottom:** Context/rationale panel. When a suggestion is focused or hovered, this panel shows the AI's explanation for why that edit was suggested (e.g., "This passive construction weakens the argument — consider active voice" or "This paragraph duplicates the point made in paragraph 2").

### Provenance Data Model

Every span of text in the document has provenance metadata:

```
{
  "span_id": "uuid",
  "text": "the actual text content",
  "origin": "human" | "ai_generated" | "ai_modified" | "human_modified",
  "origin_detail": {
    "author": "author_id",
    "timestamp": "ISO 8601",
    "edit_type": "original" | "grammar_fix" | "wording_change" | "organizational_move" | "human_grammar_fix" | "human_wording_change" | "human_organizational_move",
    "parent_span_id": "uuid or null (links to what this was derived from)",
    "ai_model": "model identifier if AI was involved, null otherwise",
    "confidence": 0.0-1.0 (how confident the edit classifier is in its categorization)
  },
  "history": [ ...array of previous states of this span... ]
}
```

This metadata is attached at the ProseMirror document level, not stored inline in the text. Think of it as a parallel data structure that maps character ranges to provenance records.

### Heatmap System

The heatmap is a visualization mode that color-codes the document text based on provenance:

**Color scheme (these are starting suggestions, we'll refine):**
- **Entirely human-written:** No highlight / very subtle cool tone (the "default" — human is the baseline)
- **AI-generated (first draft by AI):** Warm tone, e.g., coral/salmon
- **AI-modified — grammar fix:** Light yellow
- **AI-modified — wording change:** Light orange  
- **AI-modified — organizational move:** Light purple
- **Human-modified — grammar fix:** Light cyan
- **Human-modified — wording change:** Light green
- **Human-modified — organizational move:** Light blue

The heatmap has two modes:
1. **Final state:** Shows the current document with all text colored by its most recent provenance.
2. **Timeline snapshots:** After the document is "complete," the system retroactively identifies approximately 4 milestone points (roughly 25%, 50%, 75%, 100% of the editing process) and renders the heatmap as it would have appeared at each point. This creates a visual narrative of how the document evolved.

### "You-ness" Score

A separate module that assesses how much the final document sounds like the author:

- Takes baseline writing samples from the author (uploaded or accumulated over time)
- Compares stylometric features: sentence length distribution, vocabulary richness, punctuation patterns, paragraph structure, word choice tendencies
- Produces a 0-100 "you-ness" score with a plain-English explanation (e.g., "This document is 73% 'you.' Your typical sentence is shorter and more direct — the longer explanatory passages in sections 2 and 4 pull the score down.")
- Also produces a straight quantitative breakdown: X% of text is human-written/edited, Y% is AI-written/edited

### Edit Classification Logic

When the **AI** suggests an edit, the classification is known at suggestion time because we control the AI agent making the suggestion. Tag it immediately:
- Grammar/spelling/punctuation fix → "grammar_fix"
- Rewording for clarity, tone, flow → "wording_change"  
- Moving text to a different location → "organizational_move"

When a **human** makes an edit, classify after the fact:
1. Compare the before/after of the ProseMirror transaction
2. Rule-based first pass:
   - Only punctuation/capitalization/whitespace changed → "human_grammar_fix"
   - Text deleted in one location and similar text inserted in another (within the same transaction or a short time window) → "human_organizational_move"
3. If ambiguous, make a lightweight Claude API call to classify the edit type
4. Attach the classification to the provenance record

## Build Order (Incremental)

Please build this in phases. Get each phase working before moving to the next.

### Phase 1: Project scaffolding and basic editor
- Set up the monorepo structure (frontend/ and backend/ directories)
- Initialize React app with TypeScript
- Install and configure TipTap with basic rich text extensions (bold, italic, headings, lists, blockquote)
- Set up FastAPI backend with a health check endpoint
- Set up SQLite database with initial schema for documents and provenance
- Get the editor rendering in the browser with the two-panel layout (right panel = editor, left panel = placeholder panels)
- Basic save/load of documents to the backend

### Phase 2: Provenance tracking foundation
- Build the custom ProseMirror plugin that intercepts all transactions
- Log every insert, delete, and replace operation with timestamp and author metadata
- Store provenance records in SQLite via the backend API
- For now, everything is tagged as "human" origin — AI integration comes later
- Build a simple debug view that shows the raw provenance log for the current document

### Phase 3: Heatmap visualization
- Build the ProseMirror decoration plugin that reads provenance metadata and applies background colors
- Implement a toggle button to switch between "normal" and "heatmap" view
- For now, only distinguish "human-written" vs "not yet categorized" — more granular colors come when we add AI and edit classification
- Make sure the heatmap colors are accessible (not just red/green — use patterns or intensity as secondary signals)

### Phase 4: AI suggestion system
- Set up Claude API integration in the backend
- Build the suggestion generation pipeline: send document context to Claude, receive suggested edits with rationale
- Display suggestions in the left top panel as inline diffs (use diff-match-patch for computing the visual diff)
- Display rationale in the left bottom panel
- Implement accept/dismiss for suggestions (Tab/Esc or click)
- When a suggestion is accepted, record it as "ai_generated" or "ai_modified" in provenance
- Tag the edit type at suggestion time based on the AI agent's intent

### Phase 5: Edit classification for human edits
- Implement the rule-based classifier for obvious human edits
- Implement the Claude API fallback for ambiguous edits
- Update the heatmap to show the full color scheme with all edit types distinguished

### Phase 6: "You-ness" scoring
- Build the stylometric analysis module in the backend
- Accept baseline writing samples (file upload)
- Compute and store the author's stylometric profile
- Score the current document against the profile
- Display the score and breakdown in the UI (could be a panel, modal, or sidebar section)

### Phase 7: Timeline snapshots
- Implement the milestone detection logic (approximately 25/50/75/100% of editing activity)
- Build the snapshot renderer that replays provenance up to each milestone and generates a heatmap
- Display the timeline as a series of thumbnail heatmaps the user can click through

## Important Notes

- **I am not an experienced Python developer.** I know R well and have conceptual understanding of everything here, but please be explicit about Python patterns and explain non-obvious choices.
- **Prioritize clarity over cleverness.** I'd rather have readable, well-commented code than elegant abstractions I can't follow.
- **The editor should feel good to write in.** Performance matters. Don't let the provenance tracking make typing feel laggy. Debounce or batch provenance writes as needed.
- **Error handling should be friendly.** If the Claude API is slow or fails, the editor should still work perfectly — AI features degrade gracefully.
- **I'll be running this locally on a Mac.** No Docker needed for now. Just straightforward local dev.

## Ask me any clarifying questions before you begin writing code.
