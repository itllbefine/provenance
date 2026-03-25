import uuid
from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter, Depends

from database import get_db
from models import DismissedSuggestionCreate, DismissedSuggestionResponse

router = APIRouter(prefix="/dismissed", tags=["dismissed"])


@router.get("/{document_id}", response_model=list[DismissedSuggestionResponse])
async def list_dismissed(
    document_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return all dismissed suggestions for a document, newest first."""
    async with db.execute(
        "SELECT * FROM dismissed_suggestions WHERE document_id = ? ORDER BY dismissed_at DESC",
        (document_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    return [
        DismissedSuggestionResponse(
            id=row["id"],
            document_id=row["document_id"],
            original_text=row["original_text"],
            suggested_text=row["suggested_text"],
            edit_type=row["edit_type"],
            rationale=row["rationale"],
            dismissed_at=row["dismissed_at"],
        )
        for row in rows
    ]


@router.post("/", response_model=DismissedSuggestionResponse)
async def create_dismissed(
    body: DismissedSuggestionCreate,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Archive a dismissed suggestion."""
    row_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    await db.execute(
        """INSERT INTO dismissed_suggestions
           (id, document_id, original_text, suggested_text, edit_type, rationale, dismissed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (row_id, body.document_id, body.original_text, body.suggested_text,
         body.edit_type, body.rationale, now),
    )
    await db.commit()

    return DismissedSuggestionResponse(
        id=row_id,
        document_id=body.document_id,
        original_text=body.original_text,
        suggested_text=body.suggested_text,
        edit_type=body.edit_type,
        rationale=body.rationale,
        dismissed_at=now,
    )


@router.delete("/{dismissed_id}")
async def delete_dismissed(
    dismissed_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Restore a dismissed suggestion (remove it from the archive)."""
    await db.execute(
        "DELETE FROM dismissed_suggestions WHERE id = ?", (dismissed_id,)
    )
    await db.commit()
    return {"ok": True}
