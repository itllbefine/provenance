from typing import Optional
from pydantic import BaseModel, Field


class DocumentCreate(BaseModel):
    title: str = "Untitled"
    # The ProseMirror document tree, serialized to a JSON string for storage
    content: str = "{}"
    context: str = ""  # User-supplied description of the document's purpose and tone


class DocumentUpdate(BaseModel):
    # All fields optional — only the fields that are provided get updated
    title: Optional[str] = None
    content: Optional[str] = None
    context: Optional[str] = None


class DocumentResponse(BaseModel):
    id: str
    title: str
    content: str
    context: str
    created_at: str
    updated_at: str


# --- Provenance events ---

class ProvenanceEventCreate(BaseModel):
    event_type: str          # 'insert', 'delete', or 'replace'
    from_pos: int
    to_pos: int
    inserted_text: str = ""
    deleted_text: str = ""
    author: str
    timestamp: str           # ISO 8601
    origin: str = "human"   # 'human' | 'ai_generated' | 'ai_modified' | 'ai_influenced'
    # AI edit types (set at suggestion time):  'grammar_fix' | 'wording_change' | 'organizational_move'
    # Human edit types (set by classifier):    'human_grammar_fix' | 'human_wording_change' | 'human_organizational_move'
    edit_type: Optional[str] = None


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
    origin: str = "human"
    edit_type: Optional[str] = None


# --- You-ness scoring ---

class StyleSampleResponse(BaseModel):
    id: str
    filename: str
    uploaded_at: str
    char_count: int


class YounessScoreResponse(BaseModel):
    score: int              # 0–100 stylometric similarity score
    explanation: str        # plain-English explanation from Claude
    human_pct: float        # % of inserted text from human edits
    ai_pct: float           # % of inserted text from AI edits
    sample_count: int       # number of baseline samples used in the score


# --- Timeline snapshots ---


class TimelineSpan(BaseModel):
    text: str
    # 'human' | 'ai_generated' | 'ai_modified' | 'boundary' (paragraph separator)
    origin: str
    edit_type: Optional[str] = None


class TimelineMilestone(BaseModel):
    id: Optional[str] = None  # snapshot DB id (null for the live "Current" snapshot)
    label: str             # "Suggest 1", "Snapshot — …", or "Current"
    event_count: int       # number of provenance events at this snapshot
    timestamp: str         # ISO 8601 timestamp of the snapshot
    spans: list[TimelineSpan]


class TimelineResponse(BaseModel):
    milestones: list[TimelineMilestone]


# --- AI suggestions ---

ALLOWED_SUGGESTION_MODELS = {"claude-sonnet-4-6", "claude-opus-4-6"}

class SuggestionRequest(BaseModel):
    document_id: str
    dismissed: list[str] = []  # original_text values the user has dismissed
    model: str = "claude-sonnet-4-6"


class SuggestionResponse(BaseModel):
    id: str
    original_text: str
    suggested_text: str
    rationale: str
    edit_type: str  # 'grammar_fix' | 'wording_change' | 'organizational_move'


# --- Chat ---

class ChatMessage(BaseModel):
    role: str  # 'user' | 'assistant'
    content: str


class SuggestedEdit(BaseModel):
    original_text: str
    suggested_text: str
    edit_type: str  # 'grammar_fix' | 'wording_change' | 'organizational_move'
    rationale: str


class ChatRequest(BaseModel):
    document_id: str
    context_text: str = ""   # selected text or focused suggestion text
    messages: list[ChatMessage] = []
    model: str = "claude-sonnet-4-6"


class ChatResponse(BaseModel):
    message: str
    suggested_edit: Optional[SuggestedEdit] = None
