"""
Timeline snapshots — triggered by Suggest clicks.

Endpoints:
  GET  /timeline/{doc_id}   — return stored snapshots + live "Current" snapshot
  GET  /timeline/{doc_id}/heatmap — provenance-tagged spans for the full document

Snapshots are created each time the user clicks "Suggest" (via the helper
create_snapshot(), called from the suggestions router).  Each snapshot
captures the document's provenance-tagged state at that moment.

The GET endpoint returns all stored snapshots in order, plus a live "Current"
snapshot computed by replaying all provenance events.

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

import json
import uuid
from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import TimelineMilestone, TimelineResponse, TimelineSpan

router = APIRouter(prefix="/timeline", tags=["timeline"])

# Type alias: each element is (char, origin, edit_type)
_DocBuffer = list[tuple[str, str, str | None]]


# -- Position helpers ----------------------------------------------------------


def _pm_end(doc: _DocBuffer) -> int:
    """Return the PM position just past the last token in the buffer."""
    text_chars = sum(1 for ch, _, _ in doc if ch != "\n")
    newlines = sum(1 for ch, _, _ in doc if ch == "\n")
    return 1 + text_chars + 2 * newlines


def _pm_to_text(pm_pos: int, doc: _DocBuffer) -> int:
    """Walk the buffer and return the text-buffer index for *pm_pos*."""
    cur_pm = 1
    for i, (ch, _, _) in enumerate(doc):
        if cur_pm >= pm_pos:
            return i
        if ch == "\n":
            cur_pm += 2
        else:
            cur_pm += 1
    return len(doc)


# -- Event application ---------------------------------------------------------


def _apply_event(doc: _DocBuffer, event: dict) -> None:
    """Apply one provenance event to the text buffer."""
    from_pm = event["from_pos"]
    to_pm = event["to_pos"]
    origin = event.get("origin") or "human"
    edit_type = event.get("edit_type")
    inserted = event.get("inserted_text") or ""
    event_type = event.get("event_type", "")

    deleted = event.get("deleted_text") or ""
    # Only override to human_edit for actual content changes, not retags.
    if event_type != "retag" and origin == "human" and inserted and deleted:
        origin = "human_edit"

    pm_end = _pm_end(doc)
    while from_pm > pm_end:
        doc.append(("\n", "boundary", None))
        pm_end = _pm_end(doc)

    from_text = _pm_to_text(from_pm, doc)
    to_text = _pm_to_text(to_pm, doc)

    from_text = min(from_text, len(doc))
    to_text = min(to_text, len(doc))

    # Re-tag: change origin in place without modifying text content.
    # This is used by the manual Attribution button to override provenance
    # tags for a selected range.
    if event_type == "retag":
        for i in range(from_text, to_text):
            ch, _, _ = doc[i]
            doc[i] = (ch, origin, edit_type)
        return

    del doc[from_text:to_text]
    new_chars: _DocBuffer = [(ch, origin, edit_type) for ch in inserted]
    doc[from_text:from_text] = new_chars


# -- Span compression ---------------------------------------------------------


def _compress(doc: _DocBuffer) -> list[dict]:
    """Merge consecutive characters with the same provenance into spans."""
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


# -- Replay helper (shared by snapshot creation and endpoints) -----------------


async def _replay_events(
    db: aiosqlite.Connection, doc_id: str
) -> tuple[_DocBuffer, list[dict]]:
    """
    Replay all provenance events for a document and return (buffer, events).
    """
    async with db.execute(
        """
        SELECT event_type, from_pos, to_pos, inserted_text, deleted_text,
               origin, edit_type, timestamp
        FROM provenance_events
        WHERE document_id = ?
        ORDER BY timestamp ASC
        """,
        (doc_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    events = [dict(row) for row in rows]
    doc_buffer: _DocBuffer = []
    for event in events:
        _apply_event(doc_buffer, event)

    return doc_buffer, events


# -- Snapshot creation (called from suggestions router) ------------------------


async def create_snapshot(
    db: aiosqlite.Connection, doc_id: str, label: str | None = None
) -> None:
    """
    Capture the current provenance state as a timeline snapshot.

    Called just before generating AI suggestions (label=None → "Suggest N")
    or manually from the toolbar (label provided by the caller).
    """
    doc_buffer, events = await _replay_events(db, doc_id)
    if not events:
        return

    spans = _compress(doc_buffer)

    # Determine the next snapshot number for this document.
    async with db.execute(
        "SELECT COALESCE(MAX(snapshot_number), 0) FROM timeline_snapshots WHERE document_id = ?",
        (doc_id,),
    ) as cursor:
        row = await cursor.fetchone()
    next_number = row[0] + 1

    now = datetime.now(timezone.utc).isoformat()

    await db.execute(
        """
        INSERT INTO timeline_snapshots (id, document_id, snapshot_number, event_count, timestamp, spans, label)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid.uuid4()),
            doc_id,
            next_number,
            len(events),
            now,
            json.dumps(spans),
            label,
        ),
    )
    await db.commit()


# -- Routes --------------------------------------------------------------------


@router.get("/{doc_id}/heatmap", response_model=list[TimelineSpan])
async def get_heatmap(
    doc_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return provenance-tagged spans for the full current document."""
    async with db.execute(
        "SELECT id FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        if await cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail="Document not found")

    doc_buffer, events = await _replay_events(db, doc_id)
    if not events:
        return []

    return [
        TimelineSpan(text=s["text"], origin=s["origin"], edit_type=s["edit_type"])
        for s in _compress(doc_buffer)
    ]


@router.get("/{doc_id}", response_model=TimelineResponse)
async def get_timeline(
    doc_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Return stored Suggest-click snapshots plus a live "Current" snapshot.
    """
    async with db.execute(
        "SELECT id FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        if await cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail="Document not found")

    # Stored snapshots from Suggest clicks and manual captures
    async with db.execute(
        """
        SELECT id, snapshot_number, event_count, timestamp, spans, label
        FROM timeline_snapshots
        WHERE document_id = ?
        ORDER BY snapshot_number ASC
        """,
        (doc_id,),
    ) as cursor:
        snap_rows = await cursor.fetchall()

    milestones: list[TimelineMilestone] = []
    for row in snap_rows:
        spans_data = json.loads(row["spans"])
        display_label = row["label"] or f"Suggest {row['snapshot_number']}"
        milestones.append(
            TimelineMilestone(
                id=row["id"],
                label=display_label,
                event_count=row["event_count"],
                timestamp=row["timestamp"],
                spans=[
                    TimelineSpan(
                        text=s["text"],
                        origin=s["origin"],
                        edit_type=s.get("edit_type"),
                    )
                    for s in spans_data
                ],
            )
        )

    # Live "Current" snapshot — replay all events
    doc_buffer, events = await _replay_events(db, doc_id)
    if events:
        now = datetime.now(timezone.utc).isoformat()
        milestones.append(
            TimelineMilestone(
                label="Current",
                event_count=len(events),
                timestamp=now,
                spans=[
                    TimelineSpan(
                        text=s["text"], origin=s["origin"], edit_type=s["edit_type"]
                    )
                    for s in _compress(doc_buffer)
                ],
            )
        )

    return TimelineResponse(milestones=milestones)


@router.post("/{doc_id}/snapshot", status_code=201)
async def create_manual_snapshot(
    doc_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Create a manual timeline snapshot labeled with the current timestamp."""
    async with db.execute(
        "SELECT id FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        if await cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail="Document not found")

    now = datetime.now(timezone.utc)
    label = "Snapshot — " + now.strftime("%b %-d, %-I:%M %p")
    await create_snapshot(db, doc_id, label=label)
    return {"ok": True}


@router.delete("/snapshot/{snapshot_id}", status_code=200)
async def delete_snapshot(
    snapshot_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Delete a stored timeline snapshot."""
    async with db.execute(
        "SELECT id FROM timeline_snapshots WHERE id = ?", (snapshot_id,)
    ) as cursor:
        if await cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail="Snapshot not found")

    await db.execute("DELETE FROM timeline_snapshots WHERE id = ?", (snapshot_id,))
    await db.commit()
    return {"ok": True}
