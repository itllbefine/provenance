import uuid
from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import DocumentCreate, DocumentResponse, DocumentUpdate

router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("/", response_model=list[DocumentResponse])
async def list_documents(db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT * FROM documents ORDER BY updated_at DESC"
    ) as cursor:
        rows = await cursor.fetchall()
    return [dict(row) for row in rows]


@router.post("/", response_model=DocumentResponse, status_code=201)
async def create_document(
    doc: DocumentCreate, db: aiosqlite.Connection = Depends(get_db)
):
    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    await db.execute(
        "INSERT INTO documents (id, title, content, context, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (doc_id, doc.title, doc.content, doc.context, now, now),
    )
    await db.commit()

    async with db.execute(
        "SELECT * FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        row = await cursor.fetchone()

    return dict(row)  # type: ignore[arg-type]


@router.get("/{doc_id}", response_model=DocumentResponse)
async def get_document(doc_id: str, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT * FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        row = await cursor.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")

    return dict(row)


@router.put("/{doc_id}", response_model=DocumentResponse)
async def update_document(
    doc_id: str,
    doc: DocumentUpdate,
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute(
        "SELECT id FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        existing = await cursor.fetchone()

    if existing is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Build the SET clause from whichever fields were actually provided.
    # Using a dict avoids writing separate queries for every field combination.
    updates: dict[str, str] = {}
    if doc.title is not None:
        updates["title"] = doc.title
    if doc.content is not None:
        updates["content"] = doc.content
    if doc.context is not None:
        updates["context"] = doc.context
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [doc_id]

    await db.execute(f"UPDATE documents SET {set_clause} WHERE id = ?", values)
    await db.commit()

    async with db.execute(
        "SELECT * FROM documents WHERE id = ?", (doc_id,)
    ) as cursor:
        row = await cursor.fetchone()

    return dict(row)  # type: ignore[arg-type]
