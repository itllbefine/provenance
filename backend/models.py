from typing import Optional
from pydantic import BaseModel, Field


class DocumentCreate(BaseModel):
    title: str = "Untitled"
    # The ProseMirror document tree, serialized to a JSON string for storage
    content: str = "{}"


class DocumentUpdate(BaseModel):
    # All fields optional — only the fields that are provided get updated
    title: Optional[str] = None
    content: Optional[str] = None


class DocumentResponse(BaseModel):
    id: str
    title: str
    content: str
    created_at: str
    updated_at: str


# --- Provenance events ---

class ProvenanceEventCreate(BaseModel):
    event_type: str   # 'insert', 'delete', or 'replace'
    from_pos: int
    to_pos: int
    inserted_text: str = ""
    deleted_text: str = ""
    author: str
    timestamp: str    # ISO 8601


class ProvenanceBatchCreate(BaseModel):
    """A batch of events all belonging to the same document."""
    document_id: str
    events: list[ProvenanceEventCreate] = Field(default_factory=list)


class ProvenanceEventResponse(BaseModel):
    id: str
    document_id: str
    event_type: str
    from_pos: int
    to_pos: int
    inserted_text: str
    deleted_text: str
    author: str
    timestamp: str
