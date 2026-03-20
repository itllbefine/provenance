"""
Timeline snapshots — Phase 7.

Endpoint:
  GET /timeline/{doc_id}   — compute 4 milestone snapshots of document history

The endpoint replays the stored provenance events in chronological order to
reconstruct what the document looked like at four milestones:
approximately the 25th, 50th, 75th, and 100th percentile of editing activity
(measured by event count, not wall-clock time).

Each snapshot is returned as a list of provenance-tagged text spans, ready
for the frontend to render as a mini heatmap.

Position replay
---------------
Provenance events store ProseMirror (PM) positions.  PM positions count
structural tokens (paragraph open/close) in addition to text characters,
so a position in PM space is not the same as a character index.

Our replay buffer is a flat list of (char, origin, edit_type) tuples where
paragraph boundaries are represented as '\\n' characters.  In PM space a
paragraph separator costs 2 tokens (close + next open), so the mapping is:

    pm_pos = 1  +  text_chars_before  +  2 * newlines_before

We convert PM positions with a linear walk (_pm_to_text), and we fill in
missing '\\n' separators when the cursor lands past the current end of the
buffer (which happens when the user pressed Enter without generating a
text-change provenance event).
"""

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import TimelineMilestone, TimelineResponse, TimelineSpan

router = APIRouter(prefix="/timeline", tags=["timeline"])

# Type alias: each element is (char, origin, edit_type)
_DocBuffer = list[tuple[str, str, str | None]]


# ── Position helpers ──────────────────────────────────────────────────────────


def _pm_end(doc: _DocBuffer) -> int:
    """
    Return the PM position just past the last token in the buffer.

    Derivation:
      - PM pos 1 is the start of the first paragraph (after the implicit
        first-paragraph-open token).
      - Each regular character costs 1 PM token.
      - Each '\\n' boundary costs 2 PM tokens (paragraph-close + paragraph-open).
    """
    text_chars = sum(1 for ch, _, _ in doc if ch != "\n")
    newlines = sum(1 for ch, _, _ in doc if ch == "\n")
    return 1 + text_chars + 2 * newlines


def _pm_to_text(pm_pos: int, doc: _DocBuffer) -> int:
    """
    Walk the buffer and return the text-buffer index for *pm_pos*.

    We start the PM counter at 1 (= inside the first paragraph, before the
    first character) and advance it by 1 for each regular character and by 2
    for each '\\n' separator.  The first index where cur_pm >= pm_pos is
    the insertion point.  Returns len(doc) if pm_pos is at or past the end.
    """
    cur_pm = 1
    for i, (ch, _, _) in enumerate(doc):
        if cur_pm >= pm_pos:
            return i
        if ch == "\n":
            cur_pm += 2  # paragraph boundary = 2 PM tokens
        else:
            cur_pm += 1  # regular character = 1 PM token
    return len(doc)


# ── Event application ─────────────────────────────────────────────────────────


def _apply_event(doc: _DocBuffer, event: dict) -> None:
    """
    Apply one provenance event to the text buffer.

    Steps:
    1. Fill in any missing '\\n' paragraph separators when the PM position
       lies past the current end of the buffer (handles Enter presses that
       don't generate a text-change event in ProvenanceExtension).
    2. Convert PM from/to positions to text-buffer indices.
    3. Delete the replaced range (may be empty for pure inserts).
    4. Insert the new characters with their provenance metadata.
    """
    from_pm = event["from_pos"]
    to_pm = event["to_pos"]
    origin = event.get("origin") or "human"
    edit_type = event.get("edit_type")
    inserted = event.get("inserted_text") or ""

    # Fill in paragraph separators if the PM position is past the buffer end.
    # Each fill adds one '\\n', which accounts for 2 missing PM tokens
    # (a paragraph-close and the following paragraph-open).
    pm_end = _pm_end(doc)
    while from_pm > pm_end:
        doc.append(("\n", "boundary", None))
        pm_end = _pm_end(doc)

    from_text = _pm_to_text(from_pm, doc)
    to_text = _pm_to_text(to_pm, doc)

    # Defensive clamp: should never be needed, but avoids crashes on corrupt data.
    from_text = min(from_text, len(doc))
    to_text = min(to_text, len(doc))

    # Delete the replaced range, then insert new characters.
    del doc[from_text:to_text]
    new_chars: _DocBuffer = [(ch, origin, edit_type) for ch in inserted]
    doc[from_text:from_text] = new_chars


# ── Span compression ──────────────────────────────────────────────────────────


def _compress(doc: _DocBuffer) -> list[dict]:
    """
    Merge consecutive characters that share the same (origin, edit_type) into
    a single span dict: {text, origin, edit_type}.

    This reduces the payload size sent to the frontend — a run of 500 human-
    typed characters becomes one span instead of 500 individual objects.
    """
    if not doc:
        return []

    spans: list[dict] = []
    cur_text, cur_origin, cur_edit = doc[0]

    for ch, origin, edit_type in doc[1:]:
        if origin == cur_origin and edit_type == cur_edit:
            cur_text += ch
        else:
            spans.append(
                {"text": cur_text, "origin": cur_origin, "edit_type": cur_edit}
            )
            cur_text, cur_origin, cur_edit = ch, origin, edit_type

    spans.append({"text": cur_text, "origin": cur_origin, "edit_type": cur_edit})
    return spans


# ── Route ─────────────────────────────────────────────────────────────────────


@router.get("/{doc_id}", response_model=TimelineResponse)
async def get_timeline(
    doc_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Compute and return milestone snapshots for a document's editing history.

    The milestones are at approximately the 25th, 50th, 75th, and 100th
    percentiles of the event sequence.  If two milestones land on the same
    event index (e.g. a document with only 2 events), duplicates are removed
    so the response contains only distinct snapshots.
    """
    # Verify the document exists before loading (potentially empty) events.
    async with db.execute(
        "SELECT id FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        doc_row = await cursor.fetchone()
    if doc_row is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Load all events for this document, oldest first.
    async with db.execute(
        """
        SELECT from_pos, to_pos, inserted_text, deleted_text,
               origin, edit_type, timestamp
        FROM provenance_events
        WHERE document_id = ?
        ORDER BY timestamp ASC
        """,
        (doc_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    events = [dict(row) for row in rows]
    n = len(events)

    if n == 0:
        return TimelineResponse(milestones=[])

    # Calculate the event index (exclusive end) for each milestone fraction.
    # max(1, ...) ensures at least one event is included even for very short docs.
    # The last slot is always pinned to n (the complete event log).
    fractions = (0.25, 0.50, 0.75, 1.00)
    raw_indices = [max(1, int(n * f)) for f in fractions]
    raw_indices[-1] = n  # guarantee the final snapshot covers all events

    # De-duplicate while preserving order so we don't replay the same state twice.
    seen: set[int] = set()
    milestone_pairs: list[tuple[float, int]] = []
    for frac, idx in zip(fractions, raw_indices):
        if idx not in seen:
            seen.add(idx)
            milestone_pairs.append((frac, idx))

    # Replay events incrementally, capturing a snapshot at each milestone.
    # We reuse the same buffer across milestones so each milestone only pays
    # for the events added since the previous one.
    doc_buffer: _DocBuffer = []
    prev_idx = 0
    milestones: list[TimelineMilestone] = []

    for frac, end_idx in milestone_pairs:
        # Apply the events that fall in this milestone's window.
        for event in events[prev_idx:end_idx]:
            _apply_event(doc_buffer, event)
        prev_idx = end_idx

        # Compress the buffer into spans for the response.
        spans = [
            TimelineSpan(
                text=s["text"],
                origin=s["origin"],
                edit_type=s["edit_type"],
            )
            for s in _compress(doc_buffer)
        ]

        milestones.append(
            TimelineMilestone(
                milestone=frac,
                event_count=end_idx,
                timestamp=events[end_idx - 1]["timestamp"],
                spans=spans,
            )
        )

    return TimelineResponse(milestones=milestones)
