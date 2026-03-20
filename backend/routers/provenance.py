import uuid

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import ProvenanceBatchCreate, ProvenanceEventResponse
from routers.classify import classify_human_edit

router = APIRouter(prefix="/provenance", tags=["provenance"])


@router.post("/events", response_model=list[ProvenanceEventResponse], status_code=201)
async def create_events(
    batch: ProvenanceBatchCreate,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Batch-insert provenance events for a document.

    The frontend sends a list of events accumulated since the last flush.
    We insert them all in one database transaction for efficiency.
    """
    if not batch.events:
        return []

    created = []
    for event in batch.events:
        # Classify human edits that arrived without an edit_type.
        # Rule-based classification runs synchronously; Claude is called only
        # for ambiguous replacements larger than a few characters.
        if event.origin == "human" and event.edit_type is None:
            event.edit_type = await classify_human_edit(
                event.inserted_text, event.deleted_text
            )

        event_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO provenance_events
                (id, document_id, event_type, from_pos, to_pos,
                 inserted_text, deleted_text, author, timestamp, origin, edit_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                batch.document_id,
                event.event_type,
                event.from_pos,
                event.to_pos,
                event.inserted_text,
                event.deleted_text,
                event.author,
                event.timestamp,
                event.origin,
                event.edit_type,
            ),
        )
        created.append(
            ProvenanceEventResponse(
                id=event_id,
                document_id=batch.document_id,
                **event.model_dump(),
            )
        )

    await db.commit()
    return created


@router.get("/events/{doc_id}", response_model=list[ProvenanceEventResponse])
async def list_events(
    doc_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return all provenance events for a document, oldest first."""
    async with db.execute(
        "SELECT * FROM provenance_events WHERE document_id = ? ORDER BY timestamp ASC",
        (doc_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    if not rows:
        # Verify the document exists so we return 404 for unknown doc IDs
        async with db.execute(
            "SELECT id FROM documents WHERE id = ?", (doc_id,)
        ) as cursor:
            doc = await cursor.fetchone()
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")

    return [dict(row) for row in rows]
